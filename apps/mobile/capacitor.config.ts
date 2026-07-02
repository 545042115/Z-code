import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ziner.code',
  appName: 'Z Code',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: true,
    buildOptions: {
      signingType: 'apk',
    },
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#0f1115',
      showSpinner: true,
      spinnerColor: '#6c8cff',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0f1115',
    },
  },
};

export default config;
