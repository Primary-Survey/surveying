import React, { useMemo } from 'react';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { RootStackParamList } from '../../App';
import { useTheme } from '../theme/ThemeProvider';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Landing'>;

export default function LandingScreen() {
  const navigation = useNavigation<Nav>();
  const { colors, toggle, mode } = useTheme();

  const styles = useMemo(() => createStyles(colors), [colors]);

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

      <View style={styles.content}>
        <Text style={styles.title}>Primary Engineering Survey</Text>
        <Text style={styles.subtitle}>Choose what you want to do</Text>

        <Pressable style={styles.primaryButton} onPress={() => navigation.navigate('Offline')}>
          <Text style={styles.primaryButtonText}>Collect Data</Text>
        </Pressable>

        <Pressable style={styles.secondaryButton} onPress={() => navigation.navigate('Login')}>
          <Text style={styles.secondaryButtonText}>Login</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
      padding: 20,
    },
    topRight: {
      position: 'absolute',
      top: 10,
      right: 12,
      zIndex: 10,
      flexDirection: 'row',
      gap: 8,
    },
    content: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
    },
    title: {
      fontSize: 24,
      fontWeight: '900',
      color: colors.text,
      textAlign: 'center',
    },
    subtitle: {
      color: colors.muted,
      textAlign: 'center',
      marginBottom: 8,
    },
    primaryButton: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: colors.primary,
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: 'center',
    },
    primaryButtonText: {
      color: colors.primaryText,
      fontWeight: '900',
      fontSize: 16,
    },
    secondaryButton: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: 'center',
    },
    secondaryButtonText: {
      color: colors.text,
      fontWeight: '800',
      fontSize: 16,
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
