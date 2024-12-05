import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

export async function getPackageDownloadCache(cacheDir: string) {
    const cacheFilePath = path.join(cacheDir, 'package-downloads.json');
    if (!existsSync(cacheFilePath)) {
        return {};
    }

    return JSON.parse(await fs.readFile(cacheFilePath, 'utf-8'));
}

export async function savePackageDownloadCache(
    cacheDir: string,
    cache: Record<string, number>
) {
    await fs.mkdir(cacheDir, { recursive: true });

    const cacheFilePath = path.join(cacheDir, 'package-downloads.json');
    await fs.writeFile(cacheFilePath, JSON.stringify(cache, null, 2));
}

export async function checkPackageDownloads(packageName: string) {
    const start = performance.now();

    const url =
        'https://api.npmjs.org/downloads/point/last-week/' + packageName;

    const req = await fetch(url);
    const json: any = await req.json();

    console.log('GET', url, `${Math.round(performance.now() - start)}ms`);

    if (typeof json.downloads !== 'number') {
        throw new Error('Bad response: no `downloads` field');
    }

    return json.downloads;
}
