import { basename } from 'node:path';

/**
 * Lockfiles only contain the path of the package and to get the name you either
 * need to read package.json (which might not be installed) or figure it out from
 * all dependencies, we rather just infer it from the path
 */
export function packageNameFromPath(path: string) {
    const i = path.lastIndexOf('node_modules/');
    if (i > 0) {
        return path.substring(i + 'node_modules/'.length, path.length);
    }

    const i1 = path.lastIndexOf('@');
    if (i1 > 0) {
        return path.substring(i1, path.length);
    }

    return basename(path);
}
