import 'react-native-gesture-handler';
import React from 'react';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import LandingScreen from './src/screens/LandingScreen';
import OfflineCollectScreen from './src/screens/OfflineCollectScreen';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import ConnectivityScreen from './src/screens/ConnectivityScreen';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';

export type RootStackParamList = {
  Landing: undefined;
  Offline: undefined;
  Login: undefined;
  Home: undefined;
  Dashboard: undefined;
  Connectivity: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}

function AppContent() {
  const { colors, mode } = useTheme();

  // Important: React Navigation v7 expects theme.fonts to exist.
  // If you pass a partial theme object (colors only), it will crash on theme.fonts.regular.
  const baseTheme = mode === 'dark' ? DarkTheme : DefaultTheme;

  const navigationTheme = {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.card,
      text: colors.text,
      border: colors.border,
      notification: colors.primary,
    },
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator initialRouteName="Landing" screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Landing" component={LandingScreen} />
        <Stack.Screen name="Offline" component={OfflineCollectScreen} />
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Dashboard" component={DashboardScreen} />
        <Stack.Screen name="Connectivity" component={ConnectivityScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
