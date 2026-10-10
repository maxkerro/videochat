import * as SecureStore from 'expo-secure-store';

/** Where the refresh token lives between app launches. Always the OS keystore (iOS Keychain /
 *  Android Keystore) -- never AsyncStorage or any other plain-text store. */
export interface TokenStorage {
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clear(): Promise<void>;
}

const KEY = 'refresh_token';

export const secureStoreStorage: TokenStorage = {
  getRefreshToken: () => SecureStore.getItemAsync(KEY),
  setRefreshToken: (token) =>
    SecureStore.setItemAsync(KEY, token, {
      // Readable after the first unlock so a background refresh works, but never copied to
      // another device through a backup or an iCloud Keychain restore.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
  clear: () => SecureStore.deleteItemAsync(KEY),
};
