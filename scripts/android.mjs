// Builds the Android app: web bundle -> Capacitor sync -> Gradle -> dist/chakra-android-*.apk
// Usage: npm run android            (debug APK)
//        npm run android -- --release (release APK, needs signing config, see README)
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
run('node build.mjs --android');
run('npx cap sync android');
const gradlew = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
run(`${gradlew} ${release ? 'assembleRelease' : 'assembleDebug'} --console=plain`, path.join(ROOT, 'android'));

const variant = release ? 'release' : 'debug';
const dir = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', variant);
const apk = fs.readdirSync(dir).find((f) => f.endsWith('.apk'));
const out = path.join(ROOT, 'dist', `chakra-android-${variant}.apk`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(path.join(dir, apk), out);
console.log(`\nAPK ready: ${out}`);
