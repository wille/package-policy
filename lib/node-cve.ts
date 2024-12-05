import semver from 'semver';

let nodeAdvisories: any = null;
async function getNodeAdvisories() {
    if (nodeAdvisories) {
        return nodeAdvisories;
    }

    const req = await fetch(
        'https://raw.githubusercontent.com/nodejs/security-wg/refs/heads/main/vuln/core/index.json',
        {
            headers: {
                'User-Agent': 'package-policy',
            },
        }
    );

    return (nodeAdvisories = await req.json());
}

export async function checkNodeVersion(nodeVersion = process.versions.node) {
    const advisories = await getNodeAdvisories();

    const problems = [];

    for (const advisory of Object.values<any>(advisories)) {
        const isVulnerable = semver.intersects(
            nodeVersion,
            advisory.vulnerable
        );
        const isPatched = semver.intersects(nodeVersion, advisory.patched);

        if (isVulnerable && !isPatched) {
            let display = advisory.cve.join(', ');

            display += `, affects Node.js ${advisory.vulnerable}, pathed in ${advisory.patched}`;

            if (advisory.overview) {
                display += `\n${advisory.overview}\n`;
            }

            problems.push(display);
        }
    }

    return problems;
}
