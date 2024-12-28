export async function fetchJson(url: string) {
    const start = performance.now();

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'package-policy',
        },
    });

    console.log('GET', url, `${Math.round(performance.now() - start)}ms`);

    if (!res.ok) {
        throw new Error(
            `Failed to fetch ${url}: ${res.status} ${res.statusText}`
        );
    }

    const json: any = await res.json();

    return json;
}
