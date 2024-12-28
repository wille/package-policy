import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fetchJson } from './fetch.js';

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
    try {
        const url =
            'https://api.npmjs.org/downloads/point/last-week/' + packageName;

        const res = await fetchJson(url);

        if (typeof res.downloads !== 'number') {
            throw new Error('Bad response: no `downloads` field');
        }

        return res.downloads;
    } catch (err) {
        console.error('Error fetching package downloads for', packageName, err);
        return -1;
    }
}
