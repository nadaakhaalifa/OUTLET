import type { ExpoConfig } from 'expo/config';

/**
 * Single source of Expo config (app.json was removed; never keep both).
 * OWNER DECISION (open question 9): bundle id / package / slug below are
 * PLACEHOLDERS. They cannot change after the first store upload. Set
 * IOS_BUNDLE_ID, ANDROID_PACKAGE and EXPO_SLUG in the EAS env before the first build.
 */
const env = (k: string, d: string): string => {
  const v = process.env[k];
  return v !== undefined && v !== '' ? v : d;
};

const bundleId = env('IOS_BUNDLE_ID', 'com.outletnk.placeholder');
const androidPackage = env('ANDROID_PACKAGE', 'com.outletnk.placeholder');
const slug = env('EXPO_SLUG', 'outlet-nk');
const easProjectId = env('EAS_PROJECT_ID', '');
// Universal/app links host. PLACEHOLDER: owner supplies the real domain.
const linkHost = env('APP_LINK_HOST', '');
const updatesChannel = env('EAS_UPDATE_CHANNEL', '');
// iPad support (ADR-0054, docs/specs/ipad-adaptation.md section 8). OWNER DECISION PENDING: stays OFF. No eas.json profile sets
// IOS_SUPPORTS_TABLET, so every committed and store build is iPhone-only. Only a local QA iPad dev-client build sets it to "true".
const supportsTablet = env('IOS_SUPPORTS_TABLET', 'false') === 'true';
const IPAD_ORIENTATIONS = [
  'UIInterfaceOrientationPortrait',
  'UIInterfaceOrientationPortraitUpsideDown',
  'UIInterfaceOrientationLandscapeLeft',
  'UIInterfaceOrientationLandscapeRight',
];

// Shown in the system permission prompts (English default; Arabic in locales/ar.json). Mention brand uploads.
const CAMERA_TEXT =
  'Z-OUTLET uses the camera to take review, return and defect photos, and, if you are a brand, product photos and ownership proof photos, only when you ask it to.';
const PHOTOS_TEXT =
  'Z-OUTLET reads photos you choose to attach to reviews and returns or, if you are a brand, brand product photos and ownership proof photos. Nothing else is read.';
// API base URL: EXPO_PUBLIC_API_BASE_URL is set per EAS build profile in eas.json (development: localhost,
// preview/production: REPLACE-*.example.invalid placeholders). Replace the placeholders with the real https
// host via the EAS dashboard env or eas.json before a store build; never put secrets here. A release build
// whose URL is unset or still a placeholder shows the "not configured" screen (services/release-guard.ts).
// Seller Center web URL (brand mode hands off long forms there), also read at runtime from EXPO_PUBLIC_SELLER_CENTER_URL.
const sellerCenterUrl = env('EXPO_PUBLIC_SELLER_CENTER_URL', '');

const privacyManifests = {
  // Tracking: none. No ATT prompt, no NSUserTrackingUsageDescription.
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [] as string[],
  // Required-reason APIs used by React Native / Expo runtime and our deps.
  NSPrivacyAccessedAPITypes: [
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'] },
  ],
  // Derived from docs/privacy/data_inventory.yaml (draft, counsel review pending).
  // None is used for tracking; all are linked to the user for app functionality.
  NSPrivacyCollectedDataTypes: [
    ...[
      'NSPrivacyCollectedDataTypePhoneNumber',
      'NSPrivacyCollectedDataTypeEmailAddress',
      'NSPrivacyCollectedDataTypeName',
      'NSPrivacyCollectedDataTypePhysicalAddress',
      'NSPrivacyCollectedDataTypeUserID',
      'NSPrivacyCollectedDataTypeDeviceID',
      'NSPrivacyCollectedDataTypePurchaseHistory',
      'NSPrivacyCollectedDataTypePhotosorVideos',
      'NSPrivacyCollectedDataTypeOtherUserContent',
      'NSPrivacyCollectedDataTypeOtherDataTypes', // DOB attestation, size measurements
    ].map((t) => ({
      NSPrivacyCollectedDataType: t,
      NSPrivacyCollectedDataTypeLinked: true,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
    })),
  ],
};

const config: ExpoConfig = {
  name: 'Z-OUTLET',
  slug,
  scheme: 'zoutlet',
  version: '0.0.1',
  // Portrait everywhere. Only local QA (QA_ALLOW_ROTATION=true, never set in any EAS profile) unlocks rotation to look at iPad landscape layouts in Expo Go.
  orientation: env('QA_ALLOW_ROTATION', 'false') === 'true' ? 'default' : 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  // The New Architecture is mandatory from Expo SDK 55 (no config flag in SDK 57 types).
  locales: { ar: './locales/ar.json', en: './locales/en.json' },
  runtimeVersion: { policy: 'fingerprint' },
  ...(easProjectId !== ''
    ? {
        updates: {
          url: `https://u.expo.dev/${easProjectId}`,
          ...(updatesChannel !== '' ? { requestHeaders: { 'expo-channel-name': updatesChannel } } : {}),
        },
      }
    : {}),
  ios: {
    supportsTablet,
    // Multitasking (Split View, Stage Manager) needs resizable windows; only when iPad support is on. iPhone stays portrait-locked.
    ...(supportsTablet ? { requireFullScreen: false } : {}),
    bundleIdentifier: bundleId,
    config: { usesNonExemptEncryption: false }, // ITSAppUsesNonExemptEncryption=false (HTTPS/OS crypto only; confirm in docs)
    infoPlist: {
      CFBundleAllowMixedLocalizations: true,
      ...(supportsTablet ? { 'UISupportedInterfaceOrientations~ipad': IPAD_ORIENTATIONS } : {}),
      NSCameraUsageDescription: CAMERA_TEXT,
      NSPhotoLibraryUsageDescription: PHOTOS_TEXT,
      NSPhotoLibraryAddUsageDescription: 'Z-OUTLET saves photos to your library only when you ask it to.',
      // Deliberately absent: NSUserTrackingUsageDescription (no ATT), NSFaceIDUsageDescription
      // (biometrics not used), NSLocation*, NSMicrophoneUsageDescription.
    },
    privacyManifests,
    ...(linkHost !== '' ? { associatedDomains: [`applinks:${linkHost}`] } : {}),
  },
  android: {
    package: androidPackage,
    allowBackup: false,
    // Edge-to-edge is always on from Expo SDK 55 (no config flag in SDK 57 types).
    adaptiveIcon: {
      backgroundColor: '#0B2527',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    // Minimal: INTERNET is implicit. CAMERA only via expo-camera/image-picker for photos.
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW'],
    ...(linkHost !== ''
      ? {
          intentFilters: [
            {
              action: 'VIEW',
              autoVerify: true,
              data: [{ scheme: 'https', host: linkHost }],
              category: ['BROWSABLE', 'DEFAULT'],
            },
          ],
        }
      : {}),
  },
  plugins: [
    'expo-router',
    ['expo-localization', { supportedLocales: { ios: ['ar', 'en'], android: ['ar', 'en'] } }],
    'expo-secure-store',
    'expo-font',
    'expo-image',
    'expo-updates',
    [
      'expo-image-picker',
      {
        photosPermission: PHOTOS_TEXT,
        cameraPermission: CAMERA_TEXT,
        microphonePermission: false,
      },
    ],
    ['expo-camera', { cameraPermission: CAMERA_TEXT, microphonePermission: false, recordAudioAndroid: false }],
    'expo-document-picker',
  ],
  experiments: { typedRoutes: true },
  extra: { sellerCenterUrl, eas: easProjectId !== '' ? { projectId: easProjectId } : {} },
};

export default config;
