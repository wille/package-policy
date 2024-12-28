#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { packageNameFromPath } from './utils.js';
import { existsSync } from 'node:fs';
import os from 'node:os';

import chalk from 'chalk';
import * as yaml from 'yaml';
import * as semver from 'semver';
import { read } from 'read';
import debug from 'debug';
import { program } from 'commander';
import parseDuration from 'parse-duration';
import { checkNodeVersion } from './node-cve.js';
import {
    checkPackageDownloads,
    getPackageDownloadCache,
    savePackageDownloadCache,
} from './package-downloads.js';
import { fetchJson } from './fetch.js';

interface Config {
    minPackageAge?: number;
    minWeeklyDownloads?: number;
    checkNodeVersion?: boolean;
    licenses?: string[];
    blacklist?: Record<string, string>;
    ignore?: Record<string, string>;
}

const defaultConfig: Config = {
    minPackageAge: parseDuration('2d')!,
    checkNodeVersion: true,
    minWeeklyDownloads: 100,
    licenses: [],
    blacklist: {},
    ignore: {},
};

interface Warning {
    package: string;
    version?: string;
    message: string;
    cacheKey?: string;
    type: 'license' | 'minPackageAge' | 'minWeeklyDownloads' | 'script';
}

interface Dependency {
    name: string;
    path: string;
    version: string;
    license: string;
}

/**
 * package.json scripts that are executed during installation
 * https://docs.npmjs.com/cli/v10/using-npm/scripts
 */
const scriptList = ['preinstall', 'install', 'postinstall', 'prepare'];

console.error = (...args) => console.log(chalk.red(...args));
console.warn = (...args) => console.log(chalk.yellow(...args));
console.debug = debug('package-policy');

/**
 * Check the locally installed package.json for any warnings.
 *
 * We check the .scripts object for any scripts that are executed during installation,
 * and the license field.
 */
async function processLocalPackageJson(
    config: Config,
    dep: Dependency,
    dir: string
): Promise<Warning[]> {
    try {
        const name = `${dep.name}@${dep.version}`;

        const data = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
        const json = JSON.parse(data);

        if (!json.scripts) {
            // No .scripts: {} found in package.json at all
            return [];
        }

        const keys = Object.keys(json.scripts);

        const problems: Warning[] = [];

        for (const script of keys) {
            const value = json.scripts[script];
            if (scriptList.includes(script)) {
                problems.push({
                    package: name,
                    message: `will run script "${script}": "${chalk.bold(value)}"`,
                    type: 'script',
                    cacheKey: `${script}: ${value}`,
                });

                console.debug(name, 'will run script', `${script}:`, value);
            }
        }

        if (config.licenses?.length) {
            if (!json.license && config.licenses) {
                problems.push({
                    package: name,
                    message: `has no license field in package.json`,
                    type: 'license',
                    cacheKey: 'no license',
                });
            }

            if (json.license && !config.licenses.includes(json.license)) {
                problems.push({
                    package: name,
                    message: `has license ${chalk.bold(chalk.yellow(json.license))} which is not in the whitelist`,
                    type: 'license',
                    cacheKey: json.license,
                });
            }
        }

        return problems;
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            console.debug('No package.json found in', dir);
            return [];
        }

        throw err;
    }
}

async function cacheRegistry(packageName: string, version: string) {
    const cacheFile = path.join(
        program.getOptionValue('cacheDir'),
        `${packageName}.json`
    );

    if (existsSync(cacheFile) && program.getOptionValue('cache')) {
        try {
            const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));

            // If the cache version changes, we query the registry again and rebuild the cache
            if (cache._version !== 1) {
                throw new Error(`Invalid cache version in ${cacheFile}`);
            }

            // If the cache doesn't include the release date of the package,
            // we'll query the registry again
            if (cache.versions.includes(version)) {
                return cache;
            }
        } catch (err) {
            console.error(
                `Failed to read cache for ${packageName}@${version}`,
                err
            );
        }
    }

    const url = `https://registry.npmjs.org/${packageName}`;
    const json = await fetchJson(url);

    if (!json.versions) {
        throw new Error(`No versions field in ${url}`);
    }

    if (!json.versions[version]) {
        throw new Error(
            `${packageName}@${version} was not found in the registry!`
        );
    }

    if (!json.time) {
        throw new Error(`No time field in ${url}`);
    }

    if (typeof json.time[version] !== 'string') {
        throw new Error(
            `${packageName}@${version} has no time field in the registry!`
        );
    }

    // The package manifest might be huge so only cache the necessary data
    const requiredData = {
        _version: 1,
        time: json.time,
        versions: Object.keys(json.versions),
    };

    if (program.getOptionValue('cache')) {
        try {
            await fs.mkdir(path.dirname(cacheFile), { recursive: true });
            await fs.writeFile(
                cacheFile,
                JSON.stringify(requiredData, null, 2),
                'utf8'
            );
        } catch (err) {
            console.error(`Failed to write cache in ${cacheFile}`, err);
        }
    }

    return requiredData;
}

/**
 * Check the package age against the minPackageAge policy.
 *
 * We need to query the npm registry to get the publish date.
 */
async function checkPackageAge(
    minPackageAge: number,
    packageName: string,
    version: string
): Promise<Warning | null> {
    try {
        const json = await cacheRegistry(packageName, version);

        const time = json.time[version];
        const date = new Date(time);
        if (date.getTime() > Date.now() - minPackageAge) {
            const daysAgo = (Date.now() - date.getTime()) / 1000 / 60 / 60 / 24;
            const hours = (Date.now() - date.getTime()) / 1000 / 60 / 60;

            const ts =
                daysAgo > 1
                    ? `${Math.floor(daysAgo)} days ago`
                    : `${Math.floor(hours)} hours ago`;

            return {
                package: packageName,
                message: `is violating the package minAge policy. Last published ${chalk.red(chalk.bold(ts))} (${time})`,
                type: 'minPackageAge',
                cacheKey: version,
            };
        }
    } catch (err) {
        console.error(
            `Failed to fetch ${packageName}@${version} from registry`,
            err
        );
    }

    return null;
}

async function readInstalledPackagesFromLockfile(
    config: Config,
    dir: string
): Promise<Dependency[]> {
    const packageJson = path.join(dir, 'package-lock.json');
    const yarnLock = path.join(dir, 'yarn.lock');
    const pnpmLock = path.join(dir, 'pnpm-lock.yaml');

    const deps: Record<string, Dependency> = {};

    if (existsSync(packageJson)) {
        const data = await fs.readFile(packageJson, 'utf8');
        const json = JSON.parse(data);

        for (const [installationPath, spec] of Object.entries<any>(
            json.packages
        )) {
            if (installationPath === '') {
                // Ignore the root module
                continue;
            }

            if (spec.link === true) {
                // Ignore linked modules
                continue;
            }

            if (spec.optional === true) {
                // Ignore optional dependencies which may not be installed.
                // We want to query the npm registry for these dependencies to check package.json for scripts
                continue;
            }

            const packageName =
                spec.name || packageNameFromPath(installationPath);

            const nameWithVersion = `${packageName}@${spec.version}`;
            if (deps[nameWithVersion]) {
                // Skip duplicates. Seen lockfiles with several installations of the same exact package in some cases, only devDependencies
                continue;
            }

            const blacklistVersion = config.blacklist?.[packageName];
            if (
                blacklistVersion &&
                semver.satisfies(spec.version, blacklistVersion, {
                    includePrerelease: true,
                })
            ) {
                throw new Error(
                    `Blacklisted version ${packageName}@${spec.version} (${blacklistVersion})`
                );
            }

            const ignoreVersion = config.ignore?.[packageName];
            if (
                ignoreVersion &&
                semver.satisfies(spec.version, ignoreVersion, {
                    includePrerelease: true,
                })
            ) {
                console.warn(
                    `Ignoring ${packageName}@${spec.version} (${ignoreVersion})`
                );
                continue;
            }

            // TODO check workspaces

            // Some packages might have a name set and be installed under a different pathname
            // Example: node_modules/string-width-cjs -> string-width

            deps[nameWithVersion] = {
                name: packageName,
                path: installationPath,
                version: spec.version,
                license: spec.license,
            };
        }
    } else if (existsSync(yarnLock)) {
        throw new Error('yaml.lock not supported yet');
    } else if (existsSync(pnpmLock)) {
        throw new Error('pnpm-lock.yaml not supported yet');
    } else {
        throw new Error('No lockfile found in ' + dir);
    }

    return Object.values(deps).sort((a, b) => {
        if (a.name < b.name) {
            return -1;
        }
        if (a.name > b.name) {
            return 1;
        }
        return 0;
    });
}

async function readWarningsFromLockfile(lockfile: string) {
    if (!existsSync(lockfile)) {
        return [];
    }

    const data = yaml.parse(await fs.readFile(lockfile, 'utf8'));
    if (!data || !data.packages || data.version !== 1) {
        return [];
    }

    return data.packages;
}

async function processRepo(dir: string) {
    const start = performance.now();

    const config = await getConfig(dir);

    const cache = program.getOptionValue('cache');
    const enableDownloadCheck =
        config.minWeeklyDownloads && config.minWeeklyDownloads > 0;

    const lockfile = path.join(dir, 'package-policy.lock');
    let cacheData = await readWarningsFromLockfile(lockfile);

    const deps = await readInstalledPackagesFromLockfile(config, dir);
    console.log(`Processing ${deps.length} dependencies in ${dir}`);

    let warnings: Warning[] = [];

    const batchSize = 32;

    // Check the downloads for all packages in the lockfile
    // A package may be installed multiple times with different versions but we only check
    // the total weekly downloads for all versions of the package
    const packageDownloadCache = cache
        ? await getPackageDownloadCache(program.getOptionValue('cacheDir'))
        : [];
    const checkedPackageDownloads = new Set();
    const packageNames = [...new Set(deps.map((dep) => dep.name))];

    // Delete package download cache for packages that isn't used anymore
    // for (const key of Object.keys(packageDownloads)) {
    //     if (!packageNames.includes(key)) {
    //         delete packageDownloads[key];
    //     }
    // }

    for (let i = 0; i < deps.length; i += batchSize) {
        const slice = deps.slice(i, i + batchSize);

        await Promise.all(
            slice.map(async (dep) => {
                const jsonWarnings = await processLocalPackageJson(
                    config,
                    dep,
                    path.join(dir, dep.path)
                );
                warnings.push(...jsonWarnings);

                if (config.minPackageAge && config.minPackageAge > 0) {
                    const ageWarning = await checkPackageAge(
                        config.minPackageAge,
                        dep.name,
                        dep.version
                    );

                    if (ageWarning) {
                        warnings.push(ageWarning);
                    }
                }

                if (
                    enableDownloadCheck &&
                    !checkedPackageDownloads.has(dep.name)
                ) {
                    const downloads =
                        packageDownloadCache[dep.name] ||
                        (await checkPackageDownloads(dep.name));

                    checkedPackageDownloads.add(dep.name);

                    if (downloads !== -1) {
                        packageDownloadCache[dep.name] = downloads;
                    }

                    if (
                        downloads !== -1 &&
                        downloads < config.minWeeklyDownloads!
                    ) {
                        warnings.push({
                            message: `had ${chalk.bold(chalk.yellow(downloads))} downloads last week`,
                            package: dep.name,
                            type: 'minWeeklyDownloads',
                            cacheKey:
                                'minWeeklyDownloads=' +
                                config.minWeeklyDownloads,
                        });
                        console.debug(
                            `${dep.name} had ${downloads} downloads last week, which is less than the minWeeklyDownloads treshold of ${config.minWeeklyDownloads}`
                        );
                    }
                }
            })
        );
    }

    console.log(
        'Checked',
        deps.length,
        'dependencies in',
        ((performance.now() - start) / 1000).toFixed(1),
        's'
    );

    let detectedProblemsCount = warnings.length;

    // Build a cache index so we can check if detected warnings are already seen
    const cacheIndex = new Map();
    for (let i = 0; i < cacheData.length; i++) {
        const c = cacheData[i];
        cacheIndex.set(`${c.package}${c.cacheKey}${c.type}`, c);
    }

    // Reset the cache and fill it with current problems. This will make sure we leave no stale entries in the lockfile
    cacheData = [];
    for (const problem of warnings) {
        cacheData.push({
            package: problem.package,
            type: problem.type,
            cacheKey: problem.cacheKey,
        });
    }

    // @ts-expect-error
    cacheData.sort((a, b) => {
        if (a.package < b.package) {
            return -1;
        }
        if (a.package > b.package) {
            return 1;
        }
        return 0;
    });

    // Filter warnings that have already been approved by the user
    warnings = warnings.filter((problem) => {
        const k = `${problem.package}${problem.cacheKey}${problem.type}`;

        if (cacheIndex.has(k)) {
            return false;
        }

        return true;
    });

    if (cache && enableDownloadCheck) {
        await savePackageDownloadCache(
            program.getOptionValue('cacheDir'),
            packageDownloadCache
        );
    }

    let detectedUncheckedProblems = warnings.length;

    const scriptProblems = warnings.filter((x) => x.type === 'script');
    if (scriptProblems.length > 0) {
        console.log(
            chalk.red(
                `𐄂 ${scriptProblems.length} packages with installation scripts that needs to be approved`
            )
        );
        for (const problem of scriptProblems) {
            console.log(' ', chalk.bold(problem.package), problem.message);
        }
    } else {
        console.log(chalk.green('✔ All checked package scripts allowed'));
    }

    const licenseProblems = warnings.filter((x) => x.type === 'license');
    if (licenseProblems.length > 0) {
        console.log(
            chalk.red(
                `𐄂 ${licenseProblems.length} packages with a bad license or missing license`
            )
        );
        for (const problem of licenseProblems) {
            console.log(' ', chalk.bold(problem.package), problem.message);
        }
    } else if (config.licenses?.length) {
        console.log(
            chalk.green('✔ All checked packages have a valid license')
        );
    }

    const packageAgeProblems = warnings.filter(
        (x) => x.type === 'minPackageAge'
    );
    if (packageAgeProblems.length > 0) {
        console.log(
            chalk.red(
                `𐄂 ${packageAgeProblems.length} packages violating the minPackageAge policy`
            )
        );
        for (const problem of packageAgeProblems) {
            console.log(' ', chalk.bold(problem.package), problem.message);
        }
    } else {
        console.log(chalk.green('✔ All checked packages are old enough'));
    }

    const veryLowUsage = warnings.filter(
        (x) => x.type === 'minWeeklyDownloads'
    );
    if (veryLowUsage.length > 0) {
        console.log(
            chalk.red(`𐄂 ${veryLowUsage.length} packages with very low usage:`)
        );
        for (const problem of veryLowUsage) {
            console.log(' ', chalk.bold(problem.package), problem.message);
        }
    } else {
        console.log(
            chalk.green(
                '✔ All checked packages have a decent amount of downloads'
            )
        );
    }

    if (detectedUncheckedProblems === 0) {
        // No problems
        return;
    }

    console.log(
        `\n${detectedProblemsCount} package warnings, ${detectedUncheckedProblems} warnings to approve\n`
    );

    if (program.getOptionValue('ci')) {
        process.exit(1);
    }

    const result = await read({
        prompt: 'Continue? [y/n]',
        default: 'y',
    });

    switch (result) {
        case 'y':
            await fs.writeFile(
                lockfile,
                yaml.stringify({
                    version: 1,
                    packages: cacheData,
                }),
                'utf8'
            );
            console.log('Saved', lockfile);
            break;
        case 'n':
        default:
            process.exit(1);
    }
}

async function getConfig(dir: string) {
    const possibleFiles = [
        path.join(dir, 'package-policy.yml'),
        path.join(dir, 'package-policy.yaml'),
        path.join(os.homedir(), '/.package-policy.yml'),
        path.join(os.homedir(), '/.package-policy.yaml'),
    ];

    const config = { ...defaultConfig };

    for (const file of possibleFiles) {
        if (existsSync(file)) {
            const data = await fs.readFile(file, 'utf8');
            Object.assign(config, yaml.parse(data));
            break;
        }
    }

    // Parse duration in string format from the config
    if (config.minPackageAge && typeof config.minPackageAge === 'string') {
        config.minPackageAge = parseDuration(config.minPackageAge as string)!;
    }

    return config;
}

async function main() {
    program.option(
        '-c, --config <path>',
        'Path to config file',
        'package-policy.yml'
    );
    program.option(
        '--cache-dir',
        'Path to cache directory',
        os.homedir() + '/.package-policy'
    );
    program.option('--cache', 'Use cache', true);
    program.option(
        '--check-node-version',
        'Check Node.js version against Node.js security-wg vulnerability list',
        true
    );
    program.option(
        '--ci',
        'CI mode will fail if the package policy is failing instead of prompting for approval and saving a lockfile',
        process.env.CI
    );
    program.option('--init', 'Create a new package-policy.yml file');

    program.parse();

    program.argument('<dirs...>', 'Directory to check');

    if (program.args.length === 0) {
        program.help();
    }

    // Check the current node version for any known vulnerabilities
    if (program.getOptionValue('checkNodeVersion')) {
        const currentNodeProblems = await checkNodeVersion(
            process.versions.node
        );
        if (currentNodeProblems.length > 0) {
            console.log(
                chalk.red(
                    'Node.js vulnerabilities found in the current node version ' +
                        process.versions.node
                )
            );
            for (const problem of currentNodeProblems) {
                console.log(problem);
            }
            process.exit(2);
        }
    }

    for (const dir of program.args.map((dir) => path.resolve(dir))) {
        if (program.getOptionValue('init')) {
            const file = path.join(dir, 'package-policy.yml');

            if (!existsSync(file)) {
                const data = yaml.stringify(defaultConfig);
                await fs.writeFile(file, data, 'utf8');
                console.log('Created', file);
            }
            continue;
        }

        const config = await getConfig(dir);

        // Load the package.json for the target repository
        const packageJson = path.join(dir, 'package.json');
        const file = await fs.readFile(packageJson, 'utf8');
        const json = JSON.parse(file);

        const check =
            program.getOptionValue('checkNodeVersion') ||
            config.checkNodeVersion !== false;
        // Check the engines.node field in package.json if it targets a vulnerable node version
        if (check && json.engines?.node) {
            const targetNodeProblems = await checkNodeVersion(
                json.engines.node
            );

            if (targetNodeProblems.length > 0) {
                console.error('Node.js vulnerabilities found in package.json');
                for (const problem of targetNodeProblems) {
                    console.error(problem);
                }
            }
        }

        await processRepo(dir);
    }
}

main();
