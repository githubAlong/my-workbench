/* Best-effort place names; weather always uses the browser's actual coordinates.
   Photon is a low-volume fallback using OpenStreetMap data. Cache successes for
   one day, failures for one minute, and share concurrent lookups. */
const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const keyFor = (lat, lon) => `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
const pending = new Map();
const cache = new Map();
const DAY = 86400000;

function place(province, prefecture, district, provider) {
  const parts = [province, prefecture, district].map(clean).filter((v, i, all) => v && all.indexOf(v) === i);
  if (!parts.length) return null;
  return { name: parts.at(-1), fullName: parts.join(' · '), province: clean(province),
    prefecture: clean(prefecture), district: clean(district), source: 'geo',
    locationResolved: true, locationProvider: provider };
}

export function parsePlace(data, provider) {
  if (provider === 'photon') {
    const p = data?.features?.[0]?.properties;
    if (!p) return null;
    // Photon 的 city 可能是乡镇/街道（咸丰县实测返回「高乐山镇」），
    // 不能拿它当行政层级；优先用 county/district 这类真实区划。
    const district = clean(p.district || p.locality || p.county);
    const prefecture = clean(p.city || p.county);
    const validPrefecture = /(镇|乡|街道|村|社区)$/.test(prefecture) ? '' : prefecture;
    return place(p.state, validPrefecture, district, provider);
  }
  const admin = Array.isArray(data?.localityInfo?.administrative) ? data.localityInfo.administrative : [];
  const level = n => admin.find(item => Number(item?.adminLevel) === n)?.name;
  return place(data?.principalSubdivision || level(4), data?.city || level(6),
    data?.locality || data?.localityName || level(8), provider);
}

async function query(url, provider, fetcher) {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(4000), credentials: 'omit' });
    if (!response.ok) return { error: [400, 401, 402, 403, 429].includes(response.status) ? 'rejected' : 'unavailable' };
    const result = parsePlace(await response.json(), provider);
    return result || { error: 'empty' };
  } catch (error) {
    return { error: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network' };
  }
}

export async function resolvePlace(lat, lon, { previous, fetcher = globalThis.fetch, now = Date.now() } = {}) {
  if (lat == null || lon == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))
    || Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) throw new Error('定位坐标无效，请重新定位');
  const key = keyFor(lat, lon);
  const previousAt = Number(previous?.locationResolvedAt);
  if (previous?.source === 'geo' && previous.locationResolved === true && previousAt > 0
    && now - previousAt >= 0 && now - previousAt < DAY && previous.lat != null && previous.lon != null
    && keyFor(previous.lat, previous.lon) === key) {
    return { ...previous, locationCached: true };
  }
  const saved = cache.get(key);
  if (saved && now < saved.expires) return { ...saved.value, locationCached: saved.value.locationResolved };
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    const errors = [];
    const providers = [
      ['bigdatacloud', `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&localityLanguage=zh`],
      ['photon', `https://photon.komoot.io/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&limit=1&radius=1`],
    ];
    for (const [provider, url] of providers) {
      const result = await query(url, provider, fetcher);
      if (result.locationResolved) {
        const value = { ...result, locationResolvedAt: now };
        cache.set(key, { value, expires: now + DAY });
        if (cache.size > 30) cache.delete(cache.keys().next().value);
        return value;
      }
      errors.push(result.error);
    }
    const value = { name: '当前位置', fullName: '当前位置', source: 'geo', locationResolved: false,
      locationErrors: [...new Set(errors)] };
    cache.set(key, { value, expires: now + 60000 });
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    return value;
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}

export function locationWarning(city) {
  const labels = { rejected: '地区查询服务拒绝访问', timeout: '地区查询超时', network: '地区查询网络连接失败',
    empty: '未查到地区名称', unavailable: '地区查询服务暂不可用' };
  const reason = (city?.locationErrors || []).map(code => labels[code]).filter(Boolean).join('；');
  return `${reason || '暂未识别地区名称'}。天气仍按当前定位坐标获取，可手动选择城市。`;
}
