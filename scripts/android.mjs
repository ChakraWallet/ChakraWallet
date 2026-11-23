// Builds the Android app: web bundle -> Capacitor sync -> Gradle -> dist/chakra-android-*.apk
// Usage: npm run android            (debug APK)
//        npm run android -- --release (release APK + AAB for Google Play, signed with the keystore in the
//                                      ANDROID_KEYSTORE_* / ANDROID_KEY_* variables, see README)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const release = process.argv.includes('--release');
const localAndroid = path.join(os.homedir(), 'AppData', 'Local', 'Android');

// JDK: JAVA_HOME if it has javac, else the portable JDK next to the Android SDK
const hasJavac = (p) => p && fs.existsSync(path.join(p, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'));
const javaHome = [process.env.JAVA_HOME, path.join(localAndroid, 'jdk21')].find(hasJavac);
if (!javaHome) throw new Error('JDK 17+ not found: set JAVA_HOME to a JDK (not a JRE)');
const androidHome = process.env.ANDROID_HOME || path.join(localAndroid, 'Sdk');
if (!fs.existsSync(androidHome)) throw new Error('Android SDK not found: set ANDROID_HOME');

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome };
const run = (cmd, cwd = ROOT) => { console.log(`\n> ${cmd}`); execSync(cmd, { cwd, env, stdio: 'inherit' }); };

fs.writeFileSync(path.join(ROOT, 'android', 'local.properties'), `sdk.dir=${androidHome.replace(/\\/g, '/')}\n`);
const signed = !!process.env.ANDROID_KEYSTORE_FILE;
if (release && !signed) console.warn('\nANDROID_KEYSTORE_FILE not set: the release APK and AAB will be UNSIGNED (Google Play refuses them)');
run('node build.mjs --android');
run('npx cap sync android');
const gradlew = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
// release: the APK (GitHub, direct install) and the AAB (Google Play) in one Gradle run, same signature
run(`${gradlew} ${release ? 'assembleRelease bundleRelease' : 'assembleDebug'} --console=plain`, path.join(ROOT, 'android'));

const variant = release ? 'release' : 'debug';
const outputs = path.join(ROOT, 'android', 'app', 'build', 'outputs');
const copyOut = (kind, ext) => {
  const dir = path.join(outputs, kind, variant);
  const file = fs.readdirSync(dir).find((f) => f.endsWith(ext));
  const out = path.join(ROOT, 'dist', `chakra-android-${variant}${ext}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(path.join(dir, file), out);
  return out;
};
console.log(`\nAPK ready: ${copyOut('apk', '.apk')}`);
if (release) console.log(`AAB ready: ${copyOut('bundle', '.aab')}${signed ? '' : ' (unsigned)'}`);
