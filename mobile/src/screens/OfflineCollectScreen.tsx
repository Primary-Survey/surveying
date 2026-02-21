import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../supabase/client';
import { useTheme } from '../theme/ThemeProvider';
import {
  roverBluetoothClient,
  type RoverLinkState,
} from '../services/roverBluetooth';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Offline'>;

type OfflinePoint = {
  id: string;
  created_at: string;
  descriptor?: string;
  lat: number;
  lng: number;
  accuracy?: number | null;
};

type OfflineProject = {
  id: string;
  name: string;
  address?: string;
  created_at: string;
  points: OfflinePoint[];
  uploaded_at?: string;
  remote_project_id?: string;
};

const STORAGE_KEY = 'offline_projects_v1';
const PENDING_UPLOAD_KEY = 'offline_pending_upload_project_id_v1';

// Approximate WGS84 meters-per-degree formulas for small local offsets.
function metersPerDegreeLat(latDeg: number) {
  const lat = (latDeg * Math.PI) / 180;
  return (
    111132.92 -
    559.82 * Math.cos(2 * lat) +
    1.175 * Math.cos(4 * lat) -
    0.0023 * Math.cos(6 * lat)
  );
}

function metersPerDegreeLng(latDeg: number) {
  const lat = (latDeg * Math.PI) / 180;
  return (
    111412.84 * Math.cos(lat) -
    93.5 * Math.cos(3 * lat) +
    0.118 * Math.cos(5 * lat)
  );
}

export default function OfflineCollectScreen() {
  const navigation = useNavigation<Nav>();
  const { colors, toggle, mode } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const scrollRef = useRef<ScrollView>(null);

  const [permissionLoading, setPermissionLoading] = useState(true);
  const [hasPermission, setHasPermission] = useState(false);

  const [projects, setProjects] = useState<OfflineProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const [projectName, setProjectName] = useState('');
  const [projectAddress, setProjectAddress] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [screen, setScreen] = useState<'projects' | 'collect'>('projects');

  const [descriptor, setDescriptor] = useState('');
  const [position, setPosition] = useState<Location.LocationObject | null>(null);
  const [watching, setWatching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [roverState, setRoverState] = useState<RoverLinkState>(roverBluetoothClient.getState());

  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [editingPointId, setEditingPointId] = useState<string | null>(null);
  const [editingDescriptor, setEditingDescriptor] = useState('');

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  const selectedPoint = useMemo(() => {
    if (!selectedProject || !selectedPointId) return null;
    return selectedProject.points.find((pt) => pt.id === selectedPointId) || null;
  }, [selectedProject, selectedPointId]);

  const roverFix = useMemo(() => {
    const lastAt = roverState.lastTelemetryAtMs;
    if (!roverState.connected) return null;
    if (!lastAt) return null;
    if (Date.now() - lastAt > 3000) return null;
    return roverState.telemetry?.fix ?? null;
  }, [roverState.connected, roverState.lastTelemetryAtMs, roverState.telemetry]);

  const activePosition = useMemo(() => {
    if (roverState.connected) {
      if (!roverFix) return null;
      return {
        lat: roverFix.lat,
        lng: roverFix.lng,
        accuracy: roverFix.accuracy_m,
        source: 'rover' as const,
      };
    }
    if (roverFix) {
      return {
        lat: roverFix.lat,
        lng: roverFix.lng,
        accuracy: roverFix.accuracy_m,
        source: 'rover' as const,
      };
    }
    if (!position?.coords) return null;
    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy ?? null,
      source: 'phone' as const,
    };
  }, [position, roverFix, roverState.connected]);

  // While collecting, if a point is highlighted, show real-time N/S/E/W offsets from it.
  const liveOffsetMeters = useMemo(() => {
    if (screen !== 'collect') return null;
    if (!selectedPoint) return null;
    if (!activePosition) return null;

    const refLat = selectedPoint.lat;
    const refLng = selectedPoint.lng;
    const curLat = activePosition.lat;
    const curLng = activePosition.lng;

    const dLat = curLat - refLat;
    const dLng = curLng - refLng;

    const northM = dLat * metersPerDegreeLat(refLat);
    const eastM = dLng * metersPerDegreeLng(refLat);

    const round2 = (n: number) => Number(n.toFixed(2));

    return {
      n: round2(Math.max(northM, 0)),
      s: round2(Math.max(-northM, 0)),
      e: round2(Math.max(eastM, 0)),
      w: round2(Math.max(-eastM, 0)),
    };
  }, [activePosition, screen, selectedPoint]);

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        setHasPermission(status === 'granted');
      } catch (e: any) {
        Alert.alert('Location error', e?.message || String(e));
        setHasPermission(false);
      } finally {
        setPermissionLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const unsubscribe = roverBluetoothClient.onState(setRoverState);
    return unsubscribe;
  }, []);

  // Live GPS updates while on the collection screen.
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    const shouldWatch = hasPermission && screen === 'collect' && !roverState.connected;

    (async () => {
      if (!shouldWatch) {
        setWatching(false);
        return;
      }

      try {
        setWatching(true);
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 250,
            distanceInterval: 0,
          },
          (pos) => {
            setPosition(pos);
          }
        );
      } catch (e) {
        setWatching(false);
        // Don't alert-loop; just stop watching.
        console.log('watchPositionAsync failed', e);
      }
    })();

    return () => {
      try {
        sub?.remove();
      } catch {}
      setWatching(false);
    };
  }, [hasPermission, roverState.connected, screen]);

  const loadProjects = async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: OfflineProject[] = raw ? JSON.parse(raw) : [];
    setProjects(parsed);
    if (!selectedProjectId && parsed.length) setSelectedProjectId(parsed[0].id);
  };

  const persistProjects = async (next: OfflineProject[]) => {
    setProjects(next);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshLocation = async () => {
    if (roverState.connected) {
      if (!roverFix) {
        Alert.alert('Waiting for rover fix', 'Rover is connected but no GNSS fix is available yet.');
      }
      return;
    }
    if (!hasPermission) {
      Alert.alert('No permission', 'Location permission is required to collect GPS points.');
      return;
    }
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setPosition(pos);
    } catch (e: any) {
      Alert.alert('Location error', e?.message || String(e));
    }
  };

  const createProject = async () => {
    const name = projectName.trim();
    if (!name) {
      Alert.alert('Missing name', 'Enter a project name first.');
      return;
    }

    const proj: OfflineProject = {
      id: String(Date.now()),
      name,
      address: projectAddress.trim() || undefined,
      created_at: new Date().toISOString(),
      points: [],
    };

    const next = [proj, ...projects];
    await persistProjects(next);
    setSelectedProjectId(proj.id);

    // Hide create UI after successful creation.
    setProjectName('');
    setProjectAddress('');
    setShowCreate(false);

    // Move into collection view for this project.
    setScreen('collect');
  };

  const addPoint = async () => {
    if (!selectedProjectId) {
      Alert.alert('Select a project', 'Create or select an offline project first.');
      return;
    }
    if (roverState.connected && !roverFix) {
      Alert.alert('Waiting for rover fix', 'Rover is connected but no GNSS fix is available yet.');
      return;
    }
    if (!hasPermission && !roverFix) {
      Alert.alert('No permission', 'Location permission is required to collect GPS points.');
      return;
    }

    setSaving(true);
    try {
      let lat: number;
      let lng: number;
      let accuracy: number | null | undefined;

      if (roverFix) {
        lat = roverFix.lat;
        lng = roverFix.lng;
        accuracy = roverFix.accuracy_m;
      } else {
        const pos =
          position ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }));
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
        accuracy = pos.coords.accuracy;
        setPosition(pos);
      }

      const point: OfflinePoint = {
        id: String(Date.now()),
        created_at: new Date().toISOString(),
        descriptor: descriptor.trim() || undefined,
        lat,
        lng,
        accuracy,
      };

      const next = projects.map((p) =>
        p.id === selectedProjectId ? { ...p, points: [point, ...p.points] } : p
      );

      await persistProjects(next);
      setDescriptor('');
    } catch (e: any) {
      Alert.alert('Save error', e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const clearSelectedProject = async () => {
    if (!selectedProject) return;
    Alert.alert(
      'Delete offline project?',
      'This removes the project and its points from this device only.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const next = projects.filter((p) => p.id !== selectedProject.id);
            await persistProjects(next);
            setSelectedProjectId(next[0]?.id ?? null);
            setScreen('projects');
          },
        },
      ]
    );
  };

  const ensureLoggedInAndUpload = async () => {
    if (!selectedProject) {
      Alert.alert('Select a project', 'Choose an offline project first.');
      return;
    }
    if (!selectedProject.points.length) {
      Alert.alert('No points', 'This offline project has no points to upload.');
      return;
    }

    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      // Persist intent and send user to login.
      await AsyncStorage.setItem(PENDING_UPLOAD_KEY, selectedProject.id);
      navigation.navigate('Login');
      return;
    }

    await uploadSelectedProject(selectedProject);
  };

  const uploadSelectedProject = async (proj: OfflineProject) => {
    setUploading(true);
    try {
      const projectId =
        // Prefer native randomUUID if available.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((globalThis as any)?.crypto?.randomUUID?.() as string | undefined) || uuidv4();

      if (!projectId) {
        throw new Error('Could not generate a project id for upload.');
      }

      // Create project in Supabase.
      // Your projects table uses UUID ids and appears to require an explicit id.
      const insertPayload = { id: projectId, name: proj.name, address: proj.address ?? null };
      const { data: insertedProjects, error: projErr } = await supabase
        .from('projects')
        .insert(insertPayload)
        .select('id');

      if (projErr) {
        // Give a clearer on-device error message.
        throw new Error(`${projErr.message}${projErr.details ? `\n${projErr.details}` : ''}`);
      }

      const remoteProjectId = insertedProjects?.[0]?.id || projectId;
      if (!remoteProjectId) throw new Error('Failed to create project in Supabase.');

      // Upload points
      const rows = proj.points
        .slice()
        .reverse()
        .map((p, idx) => ({
          // data_points.id is also non-null in your schema, so generate UUIDs for each row
          id:
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ((globalThis as any)?.crypto?.randomUUID?.() as string | undefined) || uuidv4(),
          project_id: remoteProjectId,
          point_index: idx + 1,
          lat: p.lat,
          lng: p.lng,
          descriptor: p.descriptor ?? null,
          // source omitted (DB default)
          deleted: false,
          created_at: p.created_at,
        }));

      // Validate ids before sending (avoid null constraint errors).
      if (rows.some((r) => !r.id)) {
        throw new Error('One or more data points are missing an id.');
      }

      const { error: ptsErr } = await supabase.from('data_points').insert(rows);
      if (ptsErr) {
        throw new Error(`${ptsErr.message}${ptsErr.details ? `\n${ptsErr.details}` : ''}`);
      }

      // Keep the offline project on-device, but mark it as uploaded.
      // (You asked that uploaded projects still show up in the offline list.)
      const uploadedAt = new Date().toISOString();
      const next = projects.map((p) =>
        p.id === proj.id ? { ...p, uploaded_at: uploadedAt, remote_project_id: remoteProjectId } : p
      );
      await persistProjects(next);
      setSelectedProjectId(proj.id);
      setScreen('projects');

      await AsyncStorage.removeItem(PENDING_UPLOAD_KEY);
      Alert.alert('Uploaded', 'Project uploaded to Supabase.');
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message || String(e));
    } finally {
      setUploading(false);
    }
  };

  // If user logged in after being prompted, auto-upload the pending project.
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const pendingId = await AsyncStorage.getItem(PENDING_UPLOAD_KEY);
        if (!pendingId) return;

        const { data } = await supabase.auth.getSession();
        if (!data?.session) return;

        const proj = projects.find((p) => p.id === pendingId);
        if (proj) {
          await uploadSelectedProject(proj);
        } else {
          await AsyncStorage.removeItem(PENDING_UPLOAD_KEY);
        }
      })();
    }, [projects])
  );

  const extraBottomPadding = editingPointId ? 320 : 80;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topRight}>
        <Pressable
          style={styles.toggleButton}
          onPress={() => navigation.navigate('Connectivity')}
        >
          <Text style={styles.toggleText}>Connectivity</Text>
        </Pressable>
        <Pressable style={styles.toggleButton} onPress={toggle}>
          <Text style={styles.toggleText}>{mode === 'dark' ? 'Light' : 'Dark'}</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 20 : 0}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[styles.content, { paddingBottom: extraBottomPadding }]}
          keyboardShouldPersistTaps="handled"
        >
        <Text style={styles.title}>Collect Data</Text>
        <Text style={styles.subtitle}>Save locally, then upload when ready.</Text>

        {permissionLoading ? (
          <ActivityIndicator />
        ) : !hasPermission && !roverState.connected ? (
          <Text style={styles.warning}>Location permission not granted.</Text>
        ) : null}

        {screen === 'projects' ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Offline Projects</Text>

            {projects.length ? (
              <View style={{ gap: 8 }}>
                {projects.map((p) => (
                  <Pressable
                    key={p.id}
                    style={styles.projectRow}
                    onPress={() => {
                      setSelectedProjectId(p.id);
                      setScreen('collect');
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.projectChipText} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text style={styles.projectChipMeta}>
                        {p.address ? p.address + ' | ' : ''}{p.points.length} pts
                        {p.uploaded_at ? ' | Uploaded' : ''}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text style={styles.subtitle}>No offline projects yet.</Text>
            )}

            <Pressable
              style={styles.primaryButton}
              onPress={() => setShowCreate((v) => !v)}
            >
              <Text style={styles.primaryText}>{showCreate ? 'Cancel' : 'Create project'}</Text>
            </Pressable>

            {showCreate ? (
              <View style={{ gap: 10 }}>
                <View style={styles.field}>
                  <Text style={styles.label}>Project name</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter project name"
                    value={projectName}
                    onChangeText={setProjectName}
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>Address (optional)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter address"
                    value={projectAddress}
                    onChangeText={setProjectAddress}
                  />
                </View>

                <Pressable style={styles.secondaryButton} onPress={createProject}>
                  <Text style={styles.secondaryText}>Save project</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : (
          <>
            {selectedProject ? (
              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.sectionTitle}>{selectedProject.name}</Text>
                  <Pressable style={styles.secondaryButtonSmall} onPress={() => setScreen('projects')}>
                    <Text style={styles.secondaryText}>Projects</Text>
                  </Pressable>
                </View>
                {selectedProject.address ? (
                  <Text style={styles.subtitle}>{selectedProject.address}</Text>
                ) : null}

                <View style={styles.row}>
                  <Pressable
                    style={[styles.primaryButton, uploading && styles.disabled]}
                    onPress={ensureLoggedInAndUpload}
                    disabled={uploading}
                  >
                    <Text style={styles.primaryText}>
                      {uploading
                        ? 'Uploading...'
                        : selectedProject.uploaded_at
                          ? 'Upload again'
                          : 'Upload project'}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.dangerButton} onPress={clearSelectedProject}>
                    <Text style={styles.dangerText}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View style={styles.card}>
              <View style={styles.field}>
                <Text style={styles.label}>Point descriptor (optional)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Pole 12 / Corner / Access point"
                  value={descriptor}
                  onChangeText={setDescriptor}
                />
              </View>

              <View style={styles.row}>
                <Pressable style={styles.secondaryButton} onPress={refreshLocation}>
                  <Text style={styles.secondaryText}>Refresh GPS</Text>
                </Pressable>
                <Pressable style={styles.primaryButton} onPress={addPoint} disabled={saving}>
                  <Text style={styles.primaryText}>{saving ? 'Saving...' : 'Add Point'}</Text>
                </Pressable>
              </View>

              <Text style={styles.coords}>
                {activePosition
                  ? `${activePosition.source === 'rover' ? 'RTK Rover' : `Live GPS${
                      watching ? '' : ' (paused)'
                    }`} - Lat: ${activePosition.lat.toFixed(6)}  Lng: ${activePosition.lng.toFixed(
                      6
                    )}  (+/-${Math.round(activePosition.accuracy ?? 0)}m)`
                  : roverState.connected
                    ? 'Rover connected - waiting for GNSS fix...'
                    : watching
                      ? 'Live GPS...'
                      : 'No location yet'}
              </Text>

              {liveOffsetMeters ? (
                <Text style={styles.offsetReadout}>
                  {`N: ${liveOffsetMeters.n.toFixed(2)}m  S: ${liveOffsetMeters.s.toFixed(
                    2
                  )}m  E: ${liveOffsetMeters.e.toFixed(2)}m  W: ${liveOffsetMeters.w.toFixed(
                    2
                  )}m`}
                </Text>
              ) : null}
            </View>

            {selectedProject ? (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Saved points ({selectedProject.points.length})</Text>

                {selectedProject.points.slice(0, 50).map((p, idx) => {
                  const isSelected = selectedPointId === p.id;
                  const isEditing = editingPointId === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      style={[styles.pointRow, isSelected && styles.pointRowSelected]}
                      onPress={() => {
                        setSelectedPointId((cur) => (cur === p.id ? null : p.id));
                        setEditingPointId(null);
                      }}
                    >
                      <Text style={styles.pointTitle}>#{selectedProject.points.length - idx}</Text>

                      {isEditing ? (
                        <View style={styles.field}>
                          <Text style={styles.label}>Point name</Text>
                          <TextInput
                            style={styles.input}
                            value={editingDescriptor}
                            onChangeText={setEditingDescriptor}
                            placeholder="Enter point name"
                            onFocus={() => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50)}
                          />
                          <View style={styles.row}>
                            <Pressable
                              style={styles.secondaryButton}
                              onPress={() => {
                                setEditingPointId(null);
                                setEditingDescriptor('');
                              }}
                            >
                              <Text style={styles.secondaryText}>Cancel</Text>
                            </Pressable>
                            <Pressable
                              style={styles.primaryButton}
                              onPress={async () => {
                                if (!selectedProjectId) return;
                                const next = projects.map((proj) => {
                                  if (proj.id !== selectedProjectId) return proj;
                                  return {
                                    ...proj,
                                    points: proj.points.map((pt) =>
                                      pt.id === p.id
                                        ? { ...pt, descriptor: editingDescriptor.trim() || undefined }
                                        : pt
                                    ),
                                  };
                                });
                                await persistProjects(next);
                                setEditingPointId(null);
                                setEditingDescriptor('');
                              }}
                            >
                              <Text style={styles.primaryText}>Save</Text>
                            </Pressable>
                          </View>

                          <Pressable
                            style={styles.dangerButton}
                            onPress={async () => {
                              if (!selectedProjectId) return;
                              const next = projects.map((proj) => {
                                if (proj.id !== selectedProjectId) return proj;
                                return { ...proj, points: proj.points.filter((pt) => pt.id !== p.id) };
                              });
                              await persistProjects(next);
                              setEditingPointId(null);
                              setEditingDescriptor('');
                              setSelectedPointId(null);
                            }}
                          >
                            <Text style={styles.dangerText}>Delete point</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <>
                          <Text style={styles.pointText} numberOfLines={1}>
                            {p.descriptor || 'No descriptor'}
                          </Text>
                          <Text style={styles.pointMeta}>
                            {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
                          </Text>

                          {isSelected ? (
                            <Pressable
                              style={styles.editPill}
                              onPress={() => {
                                setEditingPointId(p.id);
                                setEditingDescriptor(p.descriptor || '');
                              }}
                            >
                              <Text style={styles.editPillText}>Edit</Text>
                            </Pressable>
                          ) : null}
                        </>
                      )}
                    </Pressable>
                  );
                })}

                {selectedProject.points.length > 50 ? (
                  <Text style={styles.subtitle}>Showing latest 50 points.</Text>
                ) : null}
              </View>
            ) : null}
          </>
        )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    topRight: {
      position: 'absolute',
      // Leave room for the status bar (battery/wifi). If you want it lower/higher, tweak this.
      top: 34,
      right: 12,
      zIndex: 10,
      flexDirection: 'row',
      gap: 8,
    },
    content: {
      padding: 20,
      paddingTop: 60,
      gap: 12,
      paddingBottom: 80,
    },
    title: {
      fontSize: 22,
      fontWeight: '900',
      color: colors.text,
    },
    subtitle: {
      color: colors.muted,
    },
    warning: {
      color: colors.danger,
      fontWeight: '700',
    },
    card: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 12,
      gap: 10,
    },
    field: {
      gap: 6,
    },
    projectRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.buttonBg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 12,
    },
    secondaryButtonSmall: {
      backgroundColor: colors.buttonBg,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 10,
      alignItems: 'center',
    },
    label: {
      color: colors.muted,
      fontWeight: '700',
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: colors.inputBg,
      color: colors.text,
    },
    row: {
      flexDirection: 'row',
      gap: 10,
    },
    rowBetween: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    primaryButton: {
      flex: 1,
      backgroundColor: colors.primary,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
    },
    primaryText: {
      color: colors.primaryText,
      fontWeight: '900',
    },
    secondaryButton: {
      flex: 1,
      backgroundColor: colors.buttonBg,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
    },
    secondaryText: {
      color: colors.text,
      fontWeight: '800',
    },
    coords: {
      color: colors.muted,
      fontSize: 12,
    },
    offsetReadout: {
      color: colors.text,
      fontSize: 12,
      fontWeight: '800',
      marginTop: 2,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '900',
      color: colors.text,
    },
    disabled: {
      opacity: 0.7,
    },
    projectChip: {
      backgroundColor: colors.buttonBg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 10,
    },
    projectChipSelected: {
      borderColor: colors.primary,
    },
    projectChipText: {
      color: colors.text,
      fontWeight: '900',
    },
    projectChipMeta: {
      color: colors.muted,
      marginTop: 2,
      fontSize: 12,
    },
    pointRow: {
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 6,
    },
    pointRowSelected: {
      borderColor: colors.primary,
      borderWidth: 1,
      borderRadius: 10,
      padding: 10,
      backgroundColor: colors.card,
    },
    editPill: {
      alignSelf: 'flex-start',
      backgroundColor: colors.buttonBg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginTop: 4,
    },
    editPillText: {
      color: colors.text,
      fontWeight: '900',
    },
    pointTitle: {
      fontWeight: '800',
      color: colors.text,
    },
    pointText: {
      color: colors.muted,
    },
    pointMeta: {
      color: colors.muted,
      fontSize: 12,
    },
    dangerButton: {
      backgroundColor: colors.danger,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
    },
    dangerText: {
      color: '#fff',
      fontWeight: '800',
    },
    toggleButton: {
      backgroundColor: colors.buttonBg,
      borderColor: colors.border,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
    },
    toggleText: {
      color: colors.text,
      fontWeight: '700',
    },
  });
