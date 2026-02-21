# Mobile App

## Rover Bluetooth integration

The app now includes `react-native-bluetooth-classic` and a rover telemetry client:

- `src/services/roverProtocol.ts`
- `src/services/roverBluetooth.ts`
- `src/screens/ConnectivityScreen.tsx`
- `src/screens/OfflineCollectScreen.tsx`

`OfflineCollectScreen` stores rover fixes for new points when rover telemetry is connected and fresh.
When the rover is not connected, it uses the phone GPS.

## Build notes

- This requires a native Android build (not Expo Go).
- Android Bluetooth permissions are set in `app.json`.
- Pair the rover in Android Bluetooth settings first, then tap `Connectivity` -> `Connect rover` in the app.

## Commands

```bash
npm install
npx expo run:android
```
