[![NPM package](https://img.shields.io/npm/v/package-policy.svg?style=flat-square)](https://www.npmjs.com/package/package-policy)
[![Node version](https://img.shields.io/badge/node-%3E=_18.0.0-blue?style=flat-square)](https://www.npmjs.com/package/package-policy)

# package-policy                  

Setup a dependency policy for your Node.js repo to protect against supply chain attacks and malicious dependencies.

package-policy will scan your lockfile and the NPM registry and check if the dependencies are passing the policy. If a dependency does not pass, the command will fail and the user will have to manually whitelist the dependency.

## Avoid running package.json installation hooks until manually audited

`npm install` will run installation scripts defined in `package.json` of every package it installs. This can be dangerous as malicious packages can run arbitrary code on your machine. By running `package-policy` before running `npm install`, you can ensure that the packages are safe to install.

The scripts that runs on `npm install` are ordered below

- `prepare`
- `preinstall`
- `install` 
- `postinstall`


Alias `npm install` and check dependencies prior to executing any
prepare/install scripts
```sh
function npp() {
    npm install $1 --ignore-scripts --foreground-scripts \
        && package-policy . \
        && npm rebuild --foreground-scripts
}
alias npp=npp
```

You can also set `ignore-scripts=true` in your `.npmrc` file to ignore all installation scripts when running `npm install` and manually run `npm rebuild` after running `package-policy` to ensure that the packages are safe to install.

```sh

> [!NOTE]
> For more information about package.json scripts see https://docs.npmjs.com/cli/v10/using-npm/scripts#npm-install


## Minimum package version age

Usage: `minPackageAge: 2d`

Set a minimum age policy of included packages to guard against recently hijacked npm packages.
This has happened several times in the wild to popular packages and is commonly detected within hours of the package being published.

It's important to be aware that this is an realistic attack vector and that the most common of these could have been saved

Read more:
> https://blog.npmjs.org/post/180565383195/details-about-the-event-stream-incident
> https://github.com/npm/npm/issues/21202

## Minimum weekly downloads

Usage: `minWeeklyDownloads: 200`

You should always try to keep your external dependency list low and carefully consider if you need another dependency in your repo.

Every dependency you add to your project increases the attack surface and the risk of a supply chain attack.

This can help against accidentally installing a package with a typo-squatting name or a package that is not maintained anymore.

## Node version validation

Usage: `checkNodeVersion: true`, `--check-node-version` (default: true)

Check the supported Node.js version in the `engines` field of the `package.json` file and ensure that it has no active CVE listed in [nodejs/security-wg](https://github.com/nodejs/security-wg/blob/main/vuln/core/index.json)

### License Policy

Usage: `licenses: ['MIT', 'ISC']` (default: none)

License whitelist policy for packages. This can help you ensure that you are not using packages with licenses that are not compatible with your project.

## Usage


### CLI
```sh
$ npm i -g package-policy
$ package-policy --init .
$ package-policy .
```


## `package-policy.yml`

```yml
# package-policy.yml

# Packages must be at least 2 days old to protect against a recent takeover
minPackageAge: 2d

# Min weekly package downloads
minWeeklyDownloads: 200

# Check your node version and the `engines.node` field in package.json for vulnerabilities
checkNodeVersion: true

# Packages must have one of the following licenses (optional)
licenses:
    - MIT
    - ISC
    - Apache-2.0

# Exclude these packages from the package policy
ignore:
    react: "16.13.1"

# Disallow these packages from being installed
block:
    lodash: "*"
    '@solana/web3.js': "1.95.6 || 1.95.7"
```

> [!NOTE]
> See the [package-policy.yml](./package-policy.yml) in this repository
