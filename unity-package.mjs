import { readFile, readdir } from 'node:fs/promises';
import { zip } from './zip.mjs';

const root = new URL('.', import.meta.url);
const packageDir = 'unity/Packages/com.prototeer.unity';

export async function unitySourceEntries() {
  const entries = [];
  async function readDirectory(path) {
    const files = await readdir(new URL(path + '/', root), { withFileTypes: true });
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const filePath = path + '/' + file.name;
      if (file.isDirectory()) await readDirectory(filePath);
      if (file.isFile() && /\.(?:cs|asmdef|json|meta|md|txt)$/.test(file.name)) {
        entries.push([filePath, await readFile(new URL(filePath, root))]);
      }
    }
  }
  await readDirectory(packageDir);
  return entries;
}

export async function buildUnityInstaller() {
  const readMe = await readFile(new URL('unity/README.md', root));
  const entries = await unitySourceEntries();
  return zip([['OPEN-ME.md', readMe],
    ...entries.map(([path, bytes]) => [path.slice('unity/'.length), bytes])], { compress: true });
}
