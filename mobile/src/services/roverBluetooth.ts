import { 
  parseRoverTelemetryLine, 
  type RoverTelemetryMessage, 
} from './roverProtocol'; 
import { PermissionsAndroid, Platform, type Permission } from 'react-native';

let BluetoothClassicModule: any = null;
try {
  // Package is optional at dev time; service reports unsupported if not present.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = require('react-native-bluetooth-classic');
  BluetoothClassicModule = loaded?.default ?? loaded;
} catch {
  BluetoothClassicModule = null;
}

export type RoverBluetoothDevice = {
  name: string;
  address: string;
};

export type RoverLinkState = {
  supported: boolean;
  connected: boolean;
  deviceName: string | null;
  deviceAddress: string | null;
  telemetry: RoverTelemetryMessage | null;
  lastTelemetryAtMs: number | null;
  lastError: string | null;
};

type StateListener = (state: RoverLinkState) => void;
type TelemetryListener = (telemetry: RoverTelemetryMessage) => void;

const INITIAL_STATE: RoverLinkState = {
  supported: BluetoothClassicModule != null,
  connected: false,
  deviceName: null,
  deviceAddress: null,
  telemetry: null,
  lastTelemetryAtMs: null,
  lastError: null,
};

function normalizeDevice(raw: any): RoverBluetoothDevice | null {
  const address = String(raw?.address ?? raw?.id ?? raw?.macAddress ?? '').trim();
  if (!address) return null;
  const name = String(raw?.name ?? raw?.deviceName ?? 'Unknown device').trim();
  return { name: name || 'Unknown device', address };
}

export class RoverBluetoothClient { 
  private state: RoverLinkState = { ...INITIAL_STATE };
  private device: any = null;
  private readSubscription: any = null;
  private disconnectSubscription: any = null;
  private buffer = '';
  private staleInterval: ReturnType<typeof setInterval> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private stateListeners = new Set<StateListener>();
  private telemetryListeners = new Set<TelemetryListener>();
  private staleAfterMs = 3000;

  getState(): RoverLinkState {
    return { ...this.state };
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onTelemetry(listener: TelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    return () => {
      this.telemetryListeners.delete(listener);
    };
  }

  async listPairedDevices(): Promise<RoverBluetoothDevice[]> { 
    if (!BluetoothClassicModule) return []; 
    await this.ensureBluetoothPermissions(); 

    // Avoid detaching methods from the module instance; some implementations rely on `this`.
    let raw: any = null;
    if (typeof BluetoothClassicModule.getBondedDevices === 'function') {
      raw = await BluetoothClassicModule.getBondedDevices();
    } else if (typeof BluetoothClassicModule.getPairedDevices === 'function') {
      raw = await BluetoothClassicModule.getPairedDevices();
    } else {
      return [];
    }
    if (!Array.isArray(raw)) return []; 
    return raw.map(normalizeDevice).filter((d): d is RoverBluetoothDevice => d != null); 
  } 

  async discoverDevices(): Promise<RoverBluetoothDevice[]> {
    if (!BluetoothClassicModule) return [];
    await this.ensureBluetoothPermissions();
    await this.ensureBluetoothEnabled();
    await this.ensureLocationPermissionForDiscovery();

    if (typeof BluetoothClassicModule.startDiscovery !== 'function') return [];
    const raw = await BluetoothClassicModule.startDiscovery();
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeDevice).filter((d): d is RoverBluetoothDevice => d != null);
  }

  async openBluetoothSettings(): Promise<void> {
    if (!BluetoothClassicModule) return;
    if (typeof BluetoothClassicModule.openBluetoothSettings === 'function') {
      await BluetoothClassicModule.openBluetoothSettings();
    }
  }

  async connect(address: string): Promise<void> { 
    if (!BluetoothClassicModule) { 
      throw new Error('Bluetooth module not available in this app build.'); 
    } 
    await this.ensureBluetoothPermissions(); 
    await this.ensureBluetoothEnabled(); 
    await this.disconnect(); 

    // Avoid detaching methods from the module instance; `connectToDevice` uses `this._nativeModule` internally.
    const canConnectToDevice = typeof BluetoothClassicModule.connectToDevice === 'function';
    const canConnect = typeof BluetoothClassicModule.connect === 'function';
    if (!canConnectToDevice && !canConnect) {
      throw new Error('Bluetooth connect function was not found.');
    }

    const options = {
      delimiter: '\n',
      charset: 'utf-8',
      // Avoid requiring bonding for development; the rover can accept insecure SPP.
      secureSocket: false,
    };

    const device = canConnectToDevice
      ? await BluetoothClassicModule.connectToDevice(address, options)
      : await BluetoothClassicModule.connect(address, options);
    if (!device) {
      throw new Error(`Failed to connect to ${address}.`);
    }

    this.device = device;
    this.buffer = '';
    this.attachDataHandler(address);
    this.attachDisconnectHandler(address);
    this.startReadPolling();
    this.patchState({
      connected: true,
      deviceAddress: address,
      deviceName: String(device?.name ?? device?.deviceName ?? 'RTK Rover'),
      lastTelemetryAtMs: null,
      lastError: null,
    });

    this.startStaleMonitor();
  }

  async disconnect(): Promise<void> {
    this.stopStaleMonitor();
    this.stopReadPolling();
    this.removeDataHandler();
    this.removeDisconnectHandler();
    const dev = this.device;
    this.device = null;
    this.buffer = '';
    if (dev) {
      try {
        if (typeof dev.disconnect === 'function') {
          await dev.disconnect();
        } else if (typeof BluetoothClassicModule?.disconnectFromDevice === 'function') {
          const address = this.state.deviceAddress;
          if (address) {
            await BluetoothClassicModule.disconnectFromDevice(address);
          }
        }
      } catch {
        // Ignore disconnect errors.
      }
    }
    this.patchState({
      connected: false,
      deviceName: null,
      deviceAddress: null,
      telemetry: null,
      lastTelemetryAtMs: null,
    });
  }

  private async ensureBluetoothEnabled(): Promise<void> { 
    if (!BluetoothClassicModule) return; 

    if (typeof BluetoothClassicModule.isBluetoothEnabled === 'function') {
      const enabled = await BluetoothClassicModule.isBluetoothEnabled();
      if (!enabled && typeof BluetoothClassicModule.requestBluetoothEnabled === 'function') {
        await BluetoothClassicModule.requestBluetoothEnabled();
      }
      return;
    }

    if (typeof BluetoothClassicModule.requestBluetoothEnabled === 'function') {
      await BluetoothClassicModule.requestBluetoothEnabled();
    }
  } 

  private async ensureBluetoothPermissions(): Promise<void> { 
    if (Platform.OS !== 'android') return; 
 
    // Platform.Version is the Android API level (number) on Android.
    const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version); 
 
    const required: Permission[] = []; 
    if (Number.isFinite(apiLevel) && apiLevel >= 31) { 
      required.push( 
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT, 
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN 
      ); 
    } else { 
      // Many Bluetooth APIs on Android <= 11 gate discovery behind location permission.
      required.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION); 
    } 
 
    const missing: Permission[] = []; 
    for (const perm of required) { 
      const has = await PermissionsAndroid.check(perm); 
      if (!has) missing.push(perm); 
    } 
    if (!missing.length) return; 
 
    const res = await PermissionsAndroid.requestMultiple(missing); 
    const denied = missing.filter((p) => res[p] !== PermissionsAndroid.RESULTS.GRANTED); 
    if (denied.length) { 
      throw new Error('Bluetooth permission was denied.'); 
    } 
  } 

  private async ensureLocationPermissionForDiscovery(): Promise<void> {
    if (Platform.OS !== 'android') return;

    // Some Android/OEM stacks still gate classic discovery behind location permission/settings.
    const perm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION as Permission;
    if (!perm) return;

    try {
      const has = await PermissionsAndroid.check(perm);
      if (has) return;
      await PermissionsAndroid.request(perm);
    } catch {
      // Ignore; discovery may still work without it on Android 12+.
    }
  }

  private async checkConnected(): Promise<boolean> {
    if (!this.device) return false;
    if (typeof this.device.isConnected === 'function') {
      try {
        return Boolean(await this.device.isConnected());
      } catch {
        return true;
      }
    }
    return true;
  }

  private attachDataHandler(addressHint?: string): void {
    this.removeDataHandler();
    if (!this.device) return;
    const onData = (event: any) => {
      const chunk = this.normalizeIncomingChunk(event);
      this.consumeChunk(chunk);
    };
    if (typeof this.device.onDataReceived === 'function') {
      this.readSubscription = this.device.onDataReceived(onData);
      return;
    }
    if (typeof BluetoothClassicModule?.onDeviceRead === 'function') {
      const address =
        addressHint ||
        this.state.deviceAddress ||
        String(this.device?.address ?? this.device?.id ?? '').trim();
      if (address) {
        // Signature for react-native-bluetooth-classic is (address, listener).
        this.readSubscription = BluetoothClassicModule.onDeviceRead(address, onData);
        return;
      }
    }
  }

  private attachDisconnectHandler(addressHint: string): void {
    this.removeDisconnectHandler();
    if (typeof BluetoothClassicModule?.onDeviceDisconnected !== 'function') return;

    this.disconnectSubscription = BluetoothClassicModule.onDeviceDisconnected((event: any) => {
      const eventAddress = String(
        event?.device?.address ?? event?.address ?? event?.id ?? ''
      ).trim();
      const activeAddress = String(this.state.deviceAddress ?? addressHint ?? '').trim();

      if (eventAddress && activeAddress && eventAddress !== activeAddress) return;

      this.patchState({
        connected: false,
        lastError: 'Bluetooth link dropped.',
      });
    });
  }

  private removeDisconnectHandler(): void {
    if (!this.disconnectSubscription) return;
    try {
      if (typeof this.disconnectSubscription.remove === 'function') {
        this.disconnectSubscription.remove();
      } else if (typeof this.disconnectSubscription === 'function') {
        this.disconnectSubscription();
      }
    } catch {
      // Ignore cleanup failures.
    } finally {
      this.disconnectSubscription = null;
    }
  }

  private startReadPolling(): void {
    this.stopReadPolling();
    this.pollInterval = setInterval(() => {
      void this.pollReadBuffer();
    }, 250);
  }

  private stopReadPolling(): void {
    if (!this.pollInterval) return;
    clearInterval(this.pollInterval);
    this.pollInterval = null;
    this.pollInFlight = false;
  }

  private async pollReadBuffer(): Promise<void> {
    if (!this.device || this.pollInFlight) return;
    this.pollInFlight = true;

    try {
      const address = String(
        this.state.deviceAddress ?? this.device?.address ?? this.device?.id ?? ''
      ).trim();
      let available = 0;

      if (typeof this.device.available === 'function') {
        try {
          available = Number(await this.device.available()) || 0;
        } catch {
          available = 0;
        }
      } else if (address && typeof BluetoothClassicModule?.availableFromDevice === 'function') {
        try {
          available = Number(await BluetoothClassicModule.availableFromDevice(address)) || 0;
        } catch {
          available = 0;
        }
      }

      if (available <= 0) return;

      const maxReads = Math.min(Math.max(available, 1), 64);
      for (let i = 0; i < maxReads; i += 1) {
        let chunk: unknown = null;

        if (typeof this.device.read === 'function') {
          chunk = await this.device.read();
        } else if (address && typeof BluetoothClassicModule?.readFromDevice === 'function') {
          chunk = await BluetoothClassicModule.readFromDevice(address);
        }

        const normalized = this.normalizeIncomingChunk(chunk);
        if (!normalized) break;
        this.consumeChunk(normalized);
      }
    } catch {
      // Polling is best-effort; event-driven reads remain primary.
    } finally {
      this.pollInFlight = false;
    }
  }

  private normalizeIncomingChunk(event: any): string {
    const unwrap = (value: any): string => {
      if (value == null) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (Array.isArray(value)) {
        const byteArray = value.every(
          (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
        )
          ? (value as number[])
          : null;
        if (byteArray) {
          try {
            if (typeof TextDecoder !== 'undefined') {
              return new TextDecoder('utf-8').decode(Uint8Array.from(byteArray));
            }
          } catch {
            // Fall through to ASCII fallback.
          }
          try {
            let out = '';
            for (let i = 0; i < byteArray.length; i += 8192) {
              out += String.fromCharCode(...byteArray.slice(i, i + 8192));
            }
            return out;
          } catch {
            // Fall through to JSON stringify fallback.
          }
        }
        try {
          return JSON.stringify(value);
        } catch {
          return '';
        }
      }
      if (typeof value === 'object') {
        if (Object.prototype.hasOwnProperty.call(value, 'data')) {
          return unwrap((value as any).data);
        }
        if (Object.prototype.hasOwnProperty.call(value, 'message')) {
          return unwrap((value as any).message);
        }
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }
      return String(value);
    };

    return unwrap(event);
  }

  private removeDataHandler(): void {
    if (!this.readSubscription) return;
    try {
      if (typeof this.readSubscription.remove === 'function') {
        this.readSubscription.remove();
      } else if (typeof this.readSubscription === 'function') {
        this.readSubscription();
      }
    } catch {
      // Ignore cleanup failures.
    } finally {
      this.readSubscription = null;
    }
  }

  private consumeChunk(chunk: string): void {
    if (!chunk) return;
    const normalized = chunk.replace(/\r/g, '').replace(/\u0000/g, '');

    // Some Android stacks deliver complete JSON frames directly (delimiter stripped).
    const directTelemetry = parseRoverTelemetryLine(normalized);
    if (directTelemetry) {
      this.buffer = '';
      this.publishTelemetry(directTelemetry);
      return;
    }

    this.buffer += normalized;

    // Also support incremental JSON delivery without newline delimiters.
    const bufferedTelemetry = parseRoverTelemetryLine(this.buffer);
    if (bufferedTelemetry) {
      this.buffer = '';
      this.publishTelemetry(bufferedTelemetry);
      return;
    }

    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const telemetry = parseRoverTelemetryLine(line);
      if (!telemetry) continue;
      this.publishTelemetry(telemetry);
    }

    // Prevent unbounded growth if we receive invalid/garbled frames.
    if (this.buffer.length > 65536) {
      this.buffer = this.buffer.slice(-4096);
    }
  }

  private publishTelemetry(telemetry: RoverTelemetryMessage): void {
    const receivedAtMs = Date.now();
    this.patchState({
      telemetry,
      lastError: null,
      connected: true,
      deviceName: telemetry.rover.device_id || this.state.deviceName,
      lastTelemetryAtMs: receivedAtMs,
    });
    this.telemetryListeners.forEach((listener) => listener(telemetry));
  }

  private startStaleMonitor(): void {
    this.stopStaleMonitor();
    this.staleInterval = setInterval(() => {
      const { connected, lastTelemetryAtMs } = this.state;
      if (!connected) return;
      if (!lastTelemetryAtMs) return;
      const age = Date.now() - lastTelemetryAtMs;
      if (age <= this.staleAfterMs) return;
      const message = `No rover telemetry received for ${Math.round(age / 1000)}s.`;
      if (this.state.lastError === message) return;
      this.patchState({
        lastError: message,
      });
    }, 500);
  }

  private stopStaleMonitor(): void {
    if (!this.staleInterval) return;
    clearInterval(this.staleInterval);
    this.staleInterval = null;
  }

  private patchState(patch: Partial<RoverLinkState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    this.stateListeners.forEach((listener) => listener(snapshot));
  }
}

export const roverBluetoothClient = new RoverBluetoothClient();
