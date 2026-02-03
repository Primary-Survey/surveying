import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Alert,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';
import { supabase } from '../supabase/client';
import { DataPoint, Project } from '../types';
import { useTheme } from '../theme/ThemeProvider';

type ViewMode = 'list' | 'map';

export default function DashboardScreen() {
  const { colors, toggle, mode } = useTheme();
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [points, setPoints] = useState<DataPoint[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [editName, setEditName] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  const projectPoints = useMemo(() => {
    if (!selectedProjectId) return [];
    return points
      .filter((p) => p.project_id === selectedProjectId && !p.deleted)
      .sort((a, b) => (a.point_index || 0) - (b.point_index || 0));
  }, [points, selectedProjectId]);

  const mapPoints = useMemo(() => {
    const src = selectedProjectId
      ? points.filter((p) => p.project_id === selectedProjectId)
      : points;
    return src
      .filter((p) => !p.deleted && p.lat != null && p.lng != null)
      .map((p) => ({
        ...p,
        // Supabase can return numeric columns as strings depending on schema/client.
        lat: typeof p.lat === 'string' ? Number(p.lat) : p.lat,
        lng: typeof p.lng === 'string' ? Number(p.lng) : p.lng,
      }))
      .filter((p) => Number.isFinite(p.lat as number) && Number.isFinite(p.lng as number));
  }, [points, selectedProjectId]);

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (selectedProject) {
      setEditName(selectedProject.name || '');
      setEditAddress(selectedProject.address || '');
    } else {
      setEditName('');
      setEditAddress('');
    }
  }, [selectedProject]);

  const deleteProjectCascade = async (projectId: string) => {
    // Prefer RPC that can bypass RLS (must be installed in Supabase).
    const { error: rpcErr } = await supabase.rpc('delete_project_cascade', {
      project_id: projectId,
    });
    if (!rpcErr) return;

    // Fallback to direct deletes (may fail under RLS)
    const { error: ptsErr } = await supabase.from('data_points').delete().eq('project_id', projectId);
    if (ptsErr) throw ptsErr;

    const { error: projErr } = await supabase.from('projects').delete().eq('id', projectId);
    if (projErr) throw projErr;
  };

  const deleteProjectsWithNoPoints = async (projData: Project[], pointData: DataPoint[]) => {
    // Requirement: If a project has no (non-deleted) data points, delete it from the DB.
    const counts = new Map<string, number>();
    for (const p of pointData) {
      if (p.deleted) continue;
      counts.set(p.project_id, (counts.get(p.project_id) || 0) + 1);
    }

    const emptyIds = projData
      .map((p) => p.id)
      .filter((id) => (counts.get(id) || 0) === 0);

    if (!emptyIds.length) return;

    await Promise.all(emptyIds.map((id) => deleteProjectCascade(id)));

    if (selectedProjectId && emptyIds.includes(selectedProjectId)) {
      setSelectedProjectId(null);
    }
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const { data: projData, error: projErr } = await supabase
        .from('projects')
        .select('id,name,address,created_at')
        .order('name', { ascending: true });
      if (projErr) throw projErr;

      const { data: pointData, error: pointErr } = await supabase
        .from('data_points')
        .select('id,project_id,point_index,lat,lng,descriptor,created_at,source,deleted')
        .order('project_id', { ascending: true })
        .order('point_index', { ascending: true });
      if (pointErr) throw pointErr;

      // Purge empty projects (per requirement), then re-fetch for a consistent view.
      await deleteProjectsWithNoPoints(projData || [], pointData || []);

      const { data: projData2, error: projErr2 } = await supabase
        .from('projects')
        .select('id,name,address,created_at')
        .order('name', { ascending: true });
      if (projErr2) throw projErr2;

      const { data: pointData2, error: pointErr2 } = await supabase
        .from('data_points')
        .select('id,project_id,point_index,lat,lng,descriptor,created_at,source,deleted')
        .order('project_id', { ascending: true })
        .order('point_index', { ascending: true });
      if (pointErr2) throw pointErr2;

      setProjects(projData2 || []);
      setPoints(pointData2 || []);
      if (selectedProjectId && !(projData2 || []).some((p: Project) => p.id === selectedProjectId)) {
        setSelectedProjectId(null);
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSelectProject = (project: Project) => {
    setSelectedProjectId(project.id);
  };

  const handleDeletePoint = async (pointId: string) => {
    try {
      await supabase.from('data_points').update({ deleted: true }).eq('id', pointId);

      const { data: remaining } = await supabase
        .from('data_points')
        .select('id,point_index')
        .eq('project_id', selectedProjectId)
        .eq('deleted', false)
        .order('point_index', { ascending: true });

      if (remaining && remaining.length) {
        await Promise.all(
          remaining.map((row: any, idx: number) =>
            supabase.from('data_points').update({ point_index: idx + 1 }).eq('id', row.id)
          )
        );
      } else if (selectedProjectId) {
        // If the last point was deleted, delete the project entirely (per requirement).
        await deleteProjectCascade(selectedProjectId);
        setSelectedProjectId(null);
      }

      await refresh();
    } catch (err: any) {
      Alert.alert('Delete failed', err?.message || String(err));
    }
  };

  const handleSaveProject = async () => {
    if (!selectedProjectId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('projects')
        .update({ name: editName.trim(), address: editAddress.trim() })
        .eq('id', selectedProjectId);
      if (error) throw error;
      await refresh();
      Alert.alert('Saved', 'Project updated.');
    } catch (err: any) {
      Alert.alert('Save failed', err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const buildExportFilename = (ext: string) => {
    const rawName = selectedProject?.name?.trim() || 'All Projects';
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, '-');

    // Use the date the project was uploaded/created (not "today").
    const createdAt = selectedProject?.created_at ? new Date(selectedProject.created_at) : new Date();
    const y = createdAt.getFullYear();
    const m = String(createdAt.getMonth() + 1).padStart(2, '0');
    const d = String(createdAt.getDate()).padStart(2, '0');
    const stamp = `${y}-${m}-${d}`;

    return `${safeName} - Survey - ${stamp}.${ext}`;
  };

  const exportCsv = async () => {
    if (!selectedProjectId) {
      Alert.alert('Select a project', 'Choose a project first.');
      return;
    }
    if (!projectPoints.length) {
      Alert.alert('No points', 'This project has no points to export.');
      return;
    }

    const available = await Sharing.isAvailableAsync();
    if (!available) {
      Alert.alert('Not supported', 'File sharing is not available on this device.');
      return;
    }

    const rows = projectPoints.map((p) => ({
      point_index: p.point_index,
      descriptor: p.descriptor || '',
      lat: p.lat,
      long: p.lng,
      source: p.source,
      created_at: p.created_at,
    }));
    const header = ['point_index', 'descriptor', 'lat', 'long', 'source', 'created_at'];
    const lines = [header.join(',')].concat(
      rows.map((r) => header.map((k) => escapeCsv(r[k as keyof typeof r])).join(','))
    );

    const filename = buildExportFilename('csv');
    const fileUri = ((FileSystem as any).cacheDirectory || (FileSystem as any).documentDirectory) + filename;

    await FileSystem.writeAsStringAsync(fileUri, lines.join('\n'), {
      // Some TS types are flaky across expo-file-system versions; at runtime this is fine.
      // @ts-expect-error
      encoding: FileSystem.EncodingType?.UTF8 || 'utf8',
    });

    await Sharing.shareAsync(fileUri, {
      mimeType: 'text/csv',
      dialogTitle: 'Share CSV',
      UTI: 'public.comma-separated-values-text',
    });
  };

  const exportXlsx = async () => {
    if (!selectedProjectId) {
      Alert.alert('Select a project', 'Choose a project first.');
      return;
    }
    if (!projectPoints.length) {
      Alert.alert('No points', 'This project has no points to export.');
      return;
    }

    const available = await Sharing.isAvailableAsync();
    if (!available) {
      Alert.alert('Not supported', 'File sharing is not available on this device.');
      return;
    }

    const rows = projectPoints.map((p) => ({
      point_index: p.point_index,
      descriptor: p.descriptor || '',
      lat: p.lat,
      long: p.lng,
      source: p.source,
      created_at: p.created_at,
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'data_points');

    const filename = buildExportFilename('xlsx');
    const uri = ((FileSystem as any).cacheDirectory || (FileSystem as any).documentDirectory) + filename;

    const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });

    await FileSystem.writeAsStringAsync(uri, wbout, {
      // @ts-expect-error
      encoding: FileSystem.EncodingType?.Base64 || 'base64',
    });

    await Sharing.shareAsync(uri, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dialogTitle: 'Share XLSX',
      UTI: 'org.openxmlformats.spreadsheetml.sheet',
    });
  };

  const styles = useMemo(() => createStyles(colors), [colors]);

  if (loading) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.toggleRow}>
        <Pressable
          style={[styles.toggleButton, viewMode === 'list' && styles.toggleActive]}
          onPress={() => setViewMode('list')}
        >
          <Text style={styles.toggleText}>List view</Text>
        </Pressable>
        <Pressable
          style={[styles.toggleButton, viewMode === 'map' && styles.toggleActive]}
          onPress={() => setViewMode('map')}
        >
          <Text style={styles.toggleText}>Map view</Text>
        </Pressable>
        <Pressable style={styles.toggleButton} onPress={toggle}>
          <Text style={styles.toggleText}>{mode === 'dark' ? 'Light' : 'Dark'}</Text>
        </Pressable>
      </View>

      {selectedProject && (
        <View style={styles.exportRow}>
          <Pressable style={styles.exportButton} onPress={exportCsv}>
            <Text style={styles.exportText}>Download CSV</Text>
          </Pressable>
          <Pressable style={styles.exportButton} onPress={exportXlsx}>
            <Text style={styles.exportText}>Download XLSX</Text>
          </Pressable>
        </View>
      )}

      {viewMode === 'map' ? (
        <MapView
          style={styles.map}
          provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
          initialRegion={{
            latitude: (mapPoints[0]?.lat as number | undefined) ?? 49.2827,
            longitude: (mapPoints[0]?.lng as number | undefined) ?? -123.1207,
            latitudeDelta: 0.08,
            longitudeDelta: 0.08,
          }}
        >
          {mapPoints.map((p) => (
            <Marker
              key={p.id}
              coordinate={{ latitude: p.lat as number, longitude: p.lng as number }}
              title={`Point ${p.point_index ?? ''}`}
              description={p.descriptor || ''}
            />
          ))}
        </MapView>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.sectionTitle}>Projects</Text>
          <FlatList
            data={projects}
            keyExtractor={(item) => item.id}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <Pressable
                style={[
                  styles.projectCard,
                  item.id === selectedProjectId && styles.projectCardSelected,
                ]}
                onPress={() => handleSelectProject(item)}
              >
                <Text style={styles.projectName}>{item.name}</Text>
                <Text style={styles.projectAddress}>{item.address || 'No address'}</Text>
              </Pressable>
            )}
          />

          {selectedProject && (
            <View style={styles.formCard}>
              <Text style={styles.sectionTitle}>Edit Project</Text>
              <Text style={styles.label}>Name</Text>
              <TextInput style={styles.input} value={editName} onChangeText={setEditName} />
              <Text style={styles.label}>Address</Text>
              <TextInput style={styles.input} value={editAddress} onChangeText={setEditAddress} />
              <Pressable
                style={[styles.primaryButton, saving && styles.disabled]}
                onPress={handleSaveProject}
                disabled={saving}
              >
                <Text style={styles.primaryText}>{saving ? 'Saving...' : 'Save changes'}</Text>
              </Pressable>

              <Pressable
                style={styles.dangerButton}
                onPress={() => {
                  if (!selectedProjectId) return;
                  Alert.alert(
                    'Delete project?',
                    'This will delete the project and all its points.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: async () => {
                          try {
                            await deleteProjectCascade(selectedProjectId);
                            setSelectedProjectId(null);
                            await refresh();
                          } catch (err: any) {
                            Alert.alert('Delete failed', err?.message || String(err));
                          }
                        },
                      },
                    ]
                  );
                }}
              >
                <Text style={styles.dangerText}>Delete project</Text>
              </Pressable>
            </View>
          )}

          {selectedProject && (
            <View style={styles.formCard}>
              <Text style={styles.sectionTitle}>Points</Text>
              {projectPoints.map((p) => (
                <View key={p.id} style={styles.pointRow}>
                  <View style={styles.pointDetails}>
                    <Text style={styles.pointTitle}>Point {p.point_index}</Text>
                    <Text style={styles.pointText}>{p.descriptor || 'No descriptor'}</Text>
                    <Text style={styles.pointText}>
                      Lat: {p.lat ?? 'n/a'} • Long: {p.lng ?? 'n/a'}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.deleteButton}
                    onPress={() => handleDeletePoint(p.id)}
                  >
                    <Text style={styles.deleteText}>Delete</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function escapeCsv(v: unknown) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[\",\n]/.test(s)) return `"${s.replace(/\"/g, '""')}"`;
  return s;
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 10,
  },
  toggleButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    backgroundColor: colors.card,
  },
  toggleActive: {
    borderColor: colors.primary,
  },
  toggleText: {
    fontWeight: '700',
    color: colors.text,
  },
  exportRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  exportButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  exportText: {
    color: colors.primaryText,
    fontWeight: '700',
  },
  map: {
    flex: 1,
  },
  scroll: {
    padding: 12,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text,
  },
  projectCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  projectCardSelected: {
    borderColor: colors.primary,
  },
  projectName: {
    fontWeight: '800',
    color: colors.text,
  },
  projectAddress: {
    color: colors.muted,
    marginTop: 4,
  },
  formCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  label: {
    color: colors.muted,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.inputBg,
    color: colors.text,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryText: {
    color: colors.primaryText,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.7,
  },
  pointRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pointDetails: {
    flex: 1,
    paddingRight: 10,
  },
  pointTitle: {
    fontWeight: '700',
    color: colors.text,
  },
  pointText: {
    color: colors.muted,
    fontSize: 12,
  },
  deleteButton: {
    backgroundColor: colors.danger,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  deleteText: {
    color: '#fff',
    fontWeight: '700',
  },
  dangerButton: {
    marginTop: 8,
    backgroundColor: colors.danger,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  dangerText: {
    color: '#fff',
    fontWeight: '800',
  },
});
