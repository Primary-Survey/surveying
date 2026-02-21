import React, { useEffect, useMemo, useState } from 'react';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { Alert, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { RootStackParamList } from '../../App';
import { supabase } from '../supabase/client';
import { useTheme } from '../theme/ThemeProvider';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

export default function HomeScreen() {
  const navigation = useNavigation<Nav>();
  const { colors, toggle, mode } = useTheme();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }: any) => {
      setEmail(data?.session?.user?.email ?? null);
      if (!data?.session) navigation.replace('Login');
    });
  }, [navigation]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    Alert.alert('Signed out');
    navigation.replace('Login');
  };

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

      <View style={styles.card}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Welcome</Text>
            <Text style={styles.subtitle}>Signed in as {email || 'unknown'}</Text>
          </View>
        </View>

        <Pressable style={styles.primaryButton} onPress={() => navigation.navigate('Dashboard')}>
          <Text style={styles.primaryButtonText}>Open Survey Dashboard</Text>
        </Pressable>

        <Pressable style={styles.secondaryButton} onPress={handleSignOut}>
          <Text style={styles.secondaryButtonText}>Sign out</Text>
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
      alignItems: 'center',
      justifyContent: 'center',
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
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: colors.card,
      padding: 20,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 12,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    title: {
      fontSize: 22,
      fontWeight: '800',
      color: colors.text,
    },
    subtitle: {
      color: colors.muted,
    },
    primaryButton: {
      marginTop: 8,
      backgroundColor: colors.primary,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
    },
    primaryButtonText: {
      color: colors.primaryText,
      fontWeight: '800',
    },
    secondaryButton: {
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: colors.buttonBg,
    },
    secondaryButtonText: {
      color: colors.text,
      fontWeight: '700',
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
