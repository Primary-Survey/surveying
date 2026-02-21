import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import {
  roverBluetoothClient,
  type RoverBluetoothDevice,
  type RoverLinkState,
} from '../services/roverBluetooth';
import { useTheme } from '../theme/ThemeProvider';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Connectivity'>;

const ROVER_DEVICE_KEY = 'rover_bt_device_address_v1';
const TELEMETRY_STALE_MS = 3000;
const ALERT_COOLDOWN_MS = 10_000;

function formatAge(ms: number | null) {
  if (ms === null) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pickDefaultDevice(
  devices: RoverBluetoothDevice[],
  preferredAddress: string | null
): RoverBluetoothDevice | null {
  if (!devices.length) return null;
  if (preferredAddress) {
    const preferred = devices.find((d) => d.address === preferredAddress);
    if (preferred) return preferred;
  }
  const named = devices.find((d) => /rover|rtk/i.test(d.name));
  // Only auto-select if it looks like the rover; don't accidentally try to connect to headphones/cars/etc.
  return named ?? null;
}

export default function ConnectivityScreen() {
  const navigation = useNavigation<Nav>();
  const { colors, toggle, mode } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [roverState, setRoverState] = useState<RoverLinkState>(roverBluetoothClient.getState());
  const [paired, setPaired] = useState<RoverBluetoothDevice[]>([]);
  const [discovered, setDiscovered] = useState<RoverBluetoothDevice[]>([]);
  const [preferredAddress, setPreferredAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  const lastAlertAtRef = useRef<number>(0);
  const prevConnectedRef = useRef<boolean>(roverState.connected);
  const prevLoraRef = useRef<boolean | null>(roverState.telemetry?.rover?.lora_connected ?? null);
  const prevGnssRef = useRef<boolean | null>(roverState.telemetry?.rover?.gnss_connected ?? null);

  const telemetry = roverState.telemetry;
  const lastTelemetryAgeMs =
    roverState.lastTelemetryAtMs != null ? Date.now() - roverState.lastTelemetryAtMs : null;
  const telemetryStale = lastTelemetryAgeMs != null && lastTelemetryAgeMs > TELEMETRY_STALE_MS;

  const loraConnected = telemetry?.rover?.lora_connected ?? false;
  const gnssConnected = telemetry?.rover?.gnss_connected ?? false;
  const fix = telemetry?.fix ?? null;

  const overallOk = roverState.connected && !telemetryStale && loraConnected && gnssConnected && !!fix;

  useEffect(() => {
    const unsubscribe = roverBluetoothClient.onState(setRoverState);
    return unsubscribe;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(ROVER_DEVICE_KEY);
        if (saved) setPreferredAddress(saved);
      } catch {}
    })();
  }, []);

  const loadPaired = async () => {
    try {
      const list = await roverBluetoothClient.listPairedDevices();
      setPaired(list);
    } catch (e: any) {
      Alert.alert('Bluetooth error', e?.message || String(e));
    }
  };

  const scanForDevices = async () => {
    setScanning(true);
    try {
      const list = await roverBluetoothClient.discoverDevices();
      setDiscovered(list);
    } catch (e: any) {
      Alert.alert('Scan failed', e?.message || String(e));
    } finally {
      setScanning(false);
    }
  };

  const openBtSettings = async () => {
    try {
      await roverBluetoothClient.openBluetoothSettings();
    } catch (e: any) {
      Alert.alert('Bluetooth error', e?.message || String(e));
    }
  };

  useEffect(() => {
    loadPaired();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const now = Date.now();
    const canAlert = now - lastAlertAtRef.current >= ALERT_COOLDOWN_MS;

    const prevConnected = prevConnectedRef.current;
    if (prevConnected && !roverState.connected && canAlert) {
      lastAlertAtRef.current = now;
      Alert.alert('Rover disconnected', roverState.lastError || 'Bluetooth link dropped.');
    }
    prevConnectedRef.current = roverState.connected;

    const prevLora = prevLoraRef.current;
    const nextLora = telemetry?.rover?.lora_connected ?? null;
    if (prevLora === true && nextLora === false && canAlert) {
      lastAlertAtRef.current = now;
      Alert.alert('Base link lost', 'Rover is not receiving corrections from the base station.');
    }
    prevLoraRef.current = nextLora;

    const prevGnss = prevGnssRef.current;
    const nextGnss = telemetry?.rover?.gnss_connected ?? null;
    if (prevGnss === true && nextGnss === false && canAlert) {
      lastAlertAtRef.current = now;
      Alert.alert('GNSS disconnected', 'Rover GNSS unit is not reporting a fix.');
    }
    prevGnssRef.current = nextGnss;
  }, [roverState.connected, roverState.lastError, telemetry?.rover?.lora_connected, telemetry?.rover?.gnss_connected]);

  const connectDefault = async () => {
    setBusy(true);
    try {
      const candidateAddresses: string[] = [];
      const seen = new Set<string>();
      const addCandidate = (addr: string | null | undefined) => {
        const normalized = String(addr ?? '').trim();
        if (!normalized) return;
        if (seen.has(normalized)) return;
        seen.add(normalized);
        candidateAddresses.push(normalized);
      };

      // Try the last-known rover first, even if Android doesn't return it in bonded list.
      addCandidate(preferredAddress);

      const list = paired.length ? paired : await roverBluetoothClient.listPairedDevices();
      const chosenPaired = pickDefaultDevice(list, preferredAddress);
      addCandidate(chosenPaired?.address);

      if (!candidateAddresses.length) {
        const discoveredList = await roverBluetoothClient.discoverDevices();
        setDiscovered(discoveredList);
        const chosenDiscovered = pickDefaultDevice(discoveredList, preferredAddress);
        addCandidate(chosenDiscovered?.address);
      }

      if (!candidateAddresses.length) {
        Alert.alert(
          'Rover not selected',
          'No rover device was found. Tap Scan to discover it (pairing not required), or use Settings to pair it in Android Bluetooth.'
        );
        return;
      }

      let lastError: unknown = null;
      for (const address of candidateAddresses) {
        try {
          await roverBluetoothClient.connect(address);
          await AsyncStorage.setItem(ROVER_DEVICE_KEY, address);
          setPreferredAddress(address);
          return;
        } catch (e) {
          lastError = e;
        }
      }

      if (lastError) {
        throw lastError;
      }
      throw new Error('Failed to connect to rover.');
    } catch (e: any) {
      Alert.alert('Connect failed', e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const connectTo = async (device: RoverBluetoothDevice) => {
    setBusy(true);
    try {
      await roverBluetoothClient.connect(device.address);
      await AsyncStorage.setItem(ROVER_DEVICE_KEY, device.address);
      setPreferredAddress(device.address);
    } catch (e: any) {
      Alert.alert('Connect failed', e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await roverBluetoothClient.disconnect();
    } catch (e: any) {
      Alert.alert('Disconnect failed', e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusPill = (ok: boolean, labelOk: string, labelBad: string) => (
    <View style={[styles.pill, ok ? styles.pillOk : styles.pillBad]}>
      <Text style={styles.pillText}>{ok ? labelOk : labelBad}</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <View style={styles.topRight}>
          <Pressable style={styles.headerButton} onPress={toggle}>
            <Text style={styles.headerButtonText}>{mode === 'dark' ? 'Light' : 'Dark'}</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Connectivity</Text>
        <Text style={styles.subtitle}>
          {overallOk
            ? 'All links look healthy.'
            : 'Connect to the rover and verify Bluetooth, base link (LoRa), and GNSS.'}
        </Text>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Rover Bluetooth</Text>
            {statusPill(roverState.connected && !telemetryStale, 'OK', 'NOT OK')}
          </View>

          <Text style={styles.meta}>
            {!roverState.supported
              ? 'Bluetooth module is not available in this app build (requires native Android build).'
              : roverState.connected
                ? `Connected: ${roverState.deviceName || roverState.deviceAddress || 'Rover'}`
                : 'Not connected'}
          </Text>
          <Text style={styles.meta}>
            {`Last telemetry: ${formatAge(lastTelemetryAgeMs)}${telemetryStale ? ' (stale)' : ''}`}
          </Text>
          {roverState.lastError ? <Text style={styles.warning}>{roverState.lastError}</Text> : null}

          <View style={styles.row}>
            <Pressable
              style={[styles.primaryButton, busy && styles.disabled]}
              onPress={connectDefault}
              disabled={!roverState.supported || busy}
            >
              <Text style={styles.primaryText}>
                {busy ? 'Working...' : roverState.connected ? 'Reconnect rover' : 'Connect rover'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryButton, (!roverState.connected || busy) && styles.disabled]}
              onPress={disconnect}
              disabled={!roverState.connected || busy}
            >
              <Text style={styles.secondaryText}>Disconnect</Text>
            </Pressable>
          </View>

          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitleSmall}>Paired devices</Text>
            <View style={styles.row}>
              <Pressable style={styles.linkButton} onPress={openBtSettings} disabled={busy}>
                <Text style={styles.linkText}>Settings</Text>
              </Pressable>
              <Pressable style={styles.linkButton} onPress={loadPaired} disabled={busy || scanning}>
                <Text style={styles.linkText}>Refresh</Text>
              </Pressable>
              <Pressable
                style={styles.linkButton}
                onPress={scanForDevices}
                disabled={!roverState.supported || busy || scanning}
              >
                <Text style={styles.linkText}>{scanning ? 'Scanning...' : 'Scan'}</Text>
              </Pressable>
            </View>
          </View>

          {paired.length ? (
            <View style={{ gap: 8 }}>
              {paired.slice(0, 10).map((d) => {
                const isPreferred = preferredAddress === d.address;
                return (
                  <Pressable
                    key={d.address}
                    style={[styles.deviceRow, isPreferred && styles.deviceRowSelected]}
                    onPress={() => connectTo(d)}
                    disabled={!roverState.supported || busy}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.deviceName} numberOfLines={1}>
                        {d.name}
                      </Text>
                      <Text style={styles.deviceMeta}>{d.address}</Text>
                    </View>
                    <Text style={styles.deviceAction}>{isPreferred ? 'Preferred' : 'Connect'}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <Text style={styles.meta}>No paired devices found.</Text>
          )}

          {discovered.length ? (
            <>
              <Text style={styles.sectionTitleSmall}>Discovered devices</Text>
              <View style={{ gap: 8 }}>
                {discovered.slice(0, 10).map((d) => (
                  <Pressable
                    key={`disc-${d.address}`}
                    style={styles.deviceRow}
                    onPress={() => connectTo(d)}
                    disabled={!roverState.supported || busy || scanning}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.deviceName} numberOfLines={1}>
                        {d.name}
                      </Text>
                      <Text style={styles.deviceMeta}>{d.address}</Text>
                    </View>
                    <Text style={styles.deviceAction}>Connect</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.meta}>
                If you do not see the rover, confirm phone Location is ON and the rover is discoverable.
              </Text>
            </>
          ) : null}
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Base Link (LoRa)</Text>
            {statusPill(roverState.connected && loraConnected, 'OK', 'NOT OK')}
          </View>
          <Text style={styles.meta}>
            {!roverState.connected
              ? 'Connect to rover to view base-link status.'
              : loraConnected
                ? 'Receiving corrections from base station.'
                : 'Not receiving corrections. Check base power/radio config/antennas.'}
          </Text>
          {telemetry ? (
            <>
              <Text style={styles.meta}>{`LoRa bytes RX: ${telemetry.rover.lora_bytes_rx}`}</Text>
              <Text style={styles.meta}>
                {`Last correction: ${telemetry.rover.last_correction_utc || 'n/a'} | Age: ${
                  fix?.correction_age_s != null ? `${fix.correction_age_s.toFixed(1)}s` : 'n/a'
                }`}
              </Text>
            </>
          ) : null}
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>GNSS</Text>
            {statusPill(roverState.connected && gnssConnected && !!fix, 'OK', 'NOT OK')}
          </View>
          <Text style={styles.meta}>
            {!roverState.connected
              ? 'Connect to rover to view GNSS status.'
              : gnssConnected
                ? 'GNSS connected.'
                : 'GNSS not connected.'}
          </Text>
          {fix ? (
            <>
              <Text style={styles.meta}>{`Fix: ${fix.quality} | Satellites: ${fix.satellites ?? 'n/a'} | HDOP: ${
                fix.hdop ?? 'n/a'
              }`}</Text>
              <Text style={styles.meta}>{`Lat: ${fix.lat.toFixed(6)}  Lng: ${fix.lng.toFixed(6)}`}</Text>
            </>
          ) : roverState.connected ? (
            <Text style={styles.warning}>No rover fix yet.</Text>
          ) : null}
        </View>

        {telemetry?.warnings?.length ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Warnings</Text>
            {telemetry.warnings.map((w, idx) => (
              <Text key={idx} style={styles.warning}>
                {w}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 6,
    },
    topRight: {
      flexDirection: 'row',
      gap: 8,
    },
    headerButton: {
      backgroundColor: colors.buttonBg,
      borderColor: colors.border,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
    },
    headerButtonText: {
      color: colors.text,
      fontWeight: '800',
    },
    backButton: {
      backgroundColor: colors.buttonBg,
      borderColor: colors.border,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
    },
    backText: {
      color: colors.text,
      fontWeight: '800',
    },
    content: {
      padding: 16,
      gap: 12,
      paddingBottom: 40,
    },
    title: {
      fontSize: 22,
      fontWeight: '900',
      color: colors.text,
    },
    subtitle: {
      color: colors.muted,
    },
    card: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 12,
      gap: 10,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '900',
      color: colors.text,
    },
    sectionTitleSmall: {
      fontSize: 14,
      fontWeight: '900',
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
      gap: 10,
    },
    meta: {
      color: colors.muted,
      fontSize: 12,
    },
    warning: {
      color: colors.danger,
      fontWeight: '800',
      fontSize: 12,
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
    disabled: {
      opacity: 0.7,
    },
    pill: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
    },
    pillOk: {
      backgroundColor: '#0b3d2e',
      borderColor: '#1f8a64',
    },
    pillBad: {
      backgroundColor: '#3d0b0b',
      borderColor: '#a82a2a',
    },
    pillText: {
      color: '#fff',
      fontWeight: '900',
      fontSize: 12,
    },
    linkButton: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: colors.buttonBg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    linkText: {
      color: colors.text,
      fontWeight: '800',
      fontSize: 12,
    },
    deviceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.buttonBg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 12,
      gap: 10,
    },
    deviceRowSelected: {
      borderColor: colors.primary,
    },
    deviceName: {
      color: colors.text,
      fontWeight: '900',
    },
    deviceMeta: {
      color: colors.muted,
      fontSize: 12,
      marginTop: 2,
    },
    deviceAction: {
      color: colors.text,
      fontWeight: '900',
      fontSize: 12,
    },
  });
