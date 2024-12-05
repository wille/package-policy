import assert from 'node:assert';
import * as T from 'node:test';

import { packageNameFromPath } from './utils.js';

T.test('Gets the package name from installation path', () => {
    assert(
        packageNameFromPath(
            'node_modules/@babel/core/node_modules/@another/package'
        ) === '@another/package'
    );
    assert(
        packageNameFromPath(
            'node_modules/@babel/core/node_modules/@another/package/node_modules/package2'
        ) === 'package2'
    );
    assert(
        packageNameFromPath('node_modules/@babel/core/node_modules/package') ===
            'package'
    );
    assert(packageNameFromPath('node_modules/package') === 'package');
    assert(packageNameFromPath('node_modules/@babel/core') === '@babel/core');
});
