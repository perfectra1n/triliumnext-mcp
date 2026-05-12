import { describe, it, expect } from 'vitest';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  createMetrics,
  normalizeRoute,
} from '../../src/http/metrics.js';

function lines(s: string): string[] {
  return s.split('\n').filter((l) => l.length > 0);
}

describe('Counter', () => {
  it('emits HELP/TYPE plus per-label-set lines', () => {
    const reg = new Registry();
    const c = reg.register(new Counter('app_calls_total', 'calls', ['tool']));
    c.inc({ tool: 'search_notes' });
    c.inc({ tool: 'search_notes' });
    c.inc({ tool: 'get_note' });
    const out = lines(reg.render());
    expect(out).toContain('# HELP app_calls_total calls');
    expect(out).toContain('# TYPE app_calls_total counter');
    expect(out).toContain('app_calls_total{tool="search_notes"} 2');
    expect(out).toContain('app_calls_total{tool="get_note"} 1');
  });

  it('treats label maps as identical if labelNames produce the same canonical order', () => {
    const reg = new Registry();
    const c = reg.register(new Counter('m_total', 'help', ['a', 'b']));
    c.inc({ a: '1', b: '2' });
    // Same labels, different insertion order — should hit the same series.
    c.inc({ b: '2', a: '1' });
    const out = lines(reg.render());
    expect(out.filter((l) => l.startsWith('m_total{'))).toEqual([
      'm_total{a="1",b="2"} 2',
    ]);
  });

  it('fills missing label values as empty strings rather than undefined', () => {
    const reg = new Registry();
    const c = reg.register(new Counter('m_total', 'help', ['a', 'b']));
    c.inc({ a: 'x' });
    const out = lines(reg.render());
    expect(out).toContain('m_total{a="x",b=""} 1');
  });

  it('rejects negative delta', () => {
    const c = new Counter('m_total', 'help');
    expect(() => c.inc({}, -1)).toThrow(/non-negative/);
  });

  it('renders zero-series counters with HELP/TYPE only', () => {
    const reg = new Registry();
    reg.register(new Counter('m_total', 'help'));
    const out = lines(reg.render());
    expect(out).toEqual(['# HELP m_total help', '# TYPE m_total counter']);
  });

  it('supports a no-label counter', () => {
    const reg = new Registry();
    const c = reg.register(new Counter('m_total', 'help'));
    c.inc();
    c.inc();
    expect(lines(reg.render())).toContain('m_total 2');
  });
});

describe('Gauge', () => {
  it('set + inc + dec compose correctly', () => {
    const reg = new Registry();
    const g = reg.register(new Gauge('g_sessions', 'help'));
    g.set(5);
    g.inc();
    g.dec({}, 2);
    expect(lines(reg.render())).toContain('g_sessions 4');
  });

  it('supports labels', () => {
    const reg = new Registry();
    const g = reg.register(new Gauge('g_build_info', 'help', ['version']));
    g.set({ version: '1.2.3' }, 1);
    expect(lines(reg.render())).toContain('g_build_info{version="1.2.3"} 1');
  });
});

describe('Histogram', () => {
  it('emits cumulative buckets, +Inf, _sum, _count', () => {
    const reg = new Registry();
    const h = reg.register(new Histogram('h_lat', 'help', [], [0.1, 0.5, 1]));
    h.observe(0.05); // 0.05 → buckets[0]+, [1]+, [2]+, +Inf+
    h.observe(0.3);  // 0.3  → buckets[1]+, [2]+, +Inf+
    h.observe(2);    // 2    → only +Inf+
    const out = lines(reg.render());
    expect(out).toContain('h_lat_bucket{le="0.1"} 1');
    expect(out).toContain('h_lat_bucket{le="0.5"} 2');
    expect(out).toContain('h_lat_bucket{le="1"} 2');
    expect(out).toContain('h_lat_bucket{le="+Inf"} 3');
    expect(out).toContain('h_lat_count 3');
    expect(out.find((l) => l.startsWith('h_lat_sum'))).toMatch(/h_lat_sum 2\.35/);
  });

  it('preserves labels across all derived series', () => {
    const reg = new Registry();
    const h = reg.register(new Histogram('h_lat', 'help', ['tool'], [0.1, 1]));
    h.observe({ tool: 'search_notes' }, 0.2);
    const out = lines(reg.render());
    expect(out.some((l) => l === 'h_lat_bucket{tool="search_notes",le="0.1"} 0')).toBe(true);
    expect(out.some((l) => l === 'h_lat_bucket{tool="search_notes",le="1"} 1')).toBe(true);
    expect(out.some((l) => l === 'h_lat_bucket{tool="search_notes",le="+Inf"} 1')).toBe(true);
    expect(out.some((l) => l === 'h_lat_count{tool="search_notes"} 1')).toBe(true);
  });

  it('silently ignores negative or non-finite observations', () => {
    const h = new Histogram('h_lat', 'help', [], [1]);
    h.observe(-1);
    h.observe(NaN);
    h.observe(Infinity);
    const out = lines(new Registry().register(h).render());
    // No series should have been recorded — HELP/TYPE only.
    expect(out.filter((l) => !l.startsWith('#'))).toEqual([]);
  });

  it('rejects non-monotonic buckets at construction', () => {
    expect(() => new Histogram('h', 'help', [], [1, 0.5])).toThrow(/strictly increasing/);
  });
});

describe('Registry', () => {
  it('refuses duplicate metric names', () => {
    const reg = new Registry();
    reg.register(new Counter('m_total', 'help'));
    expect(() => reg.register(new Counter('m_total', 'other help'))).toThrow(/already registered/);
  });

  it('escapes special characters in label values', () => {
    const reg = new Registry();
    const c = reg.register(new Counter('m_total', 'help', ['x']));
    c.inc({ x: 'a"b\\c\nd' });
    const out = reg.render();
    expect(out).toContain('m_total{x="a\\"b\\\\c\\nd"} 1');
  });

  it('escapes backslash and newline in HELP', () => {
    const reg = new Registry();
    reg.register(new Counter('m_total', 'line1\nline2\\here'));
    expect(reg.render()).toContain('# HELP m_total line1\\nline2\\\\here');
  });

  it('rejects invalid metric names', () => {
    expect(() => new Counter('1bad-name', 'help')).toThrow(/invalid metric name/);
  });
});

describe('createMetrics — declared surface', () => {
  it('exposes the documented series after a single tool call + connect cycle', () => {
    const m = createMetrics('1.0.0');
    m.toolCallsTotal.inc({ tool: 'search_notes', ok: 'true', error: 'none' });
    m.toolCallDuration.observe({ tool: 'search_notes' }, 0.042);
    m.sseConnectsTotal.inc();
    m.sseSessions.inc();
    m.collectProcess();
    const out = m.registry.render();

    expect(out).toContain('triliumnext_mcp_build_info{version="1.0.0"} 1');
    expect(out).toContain(
      'triliumnext_mcp_tool_calls_total{tool="search_notes",ok="true",error="none"} 1'
    );
    expect(out).toContain('triliumnext_mcp_tool_call_duration_seconds_count{tool="search_notes"} 1');
    expect(out).toContain('triliumnext_mcp_sse_connects_total 1');
    expect(out).toContain('triliumnext_mcp_sse_sessions 1');
    // Process metrics should have a sensible non-negative value.
    const uptimeLine = lines(out).find((l) => l.startsWith('triliumnext_mcp_process_uptime_seconds '));
    expect(uptimeLine).toBeDefined();
    expect(parseFloat(uptimeLine!.split(' ')[1])).toBeGreaterThanOrEqual(0);
  });

  it('renders a Prometheus-parsable document even when no observations exist', () => {
    const m = createMetrics('1.0.0');
    const out = m.registry.render();
    // Every declared metric must have HELP and TYPE present.
    for (const name of [
      'triliumnext_mcp_build_info',
      'triliumnext_mcp_http_requests_total',
      'triliumnext_mcp_http_request_duration_seconds',
      'triliumnext_mcp_tool_calls_total',
      'triliumnext_mcp_tool_call_duration_seconds',
      'triliumnext_mcp_sse_sessions',
      'triliumnext_mcp_sse_connects_total',
      'triliumnext_mcp_sse_closes_total',
      'triliumnext_mcp_sse_connect_failures_total',
      'triliumnext_mcp_process_uptime_seconds',
      'triliumnext_mcp_process_resident_memory_bytes',
    ]) {
      expect(out).toContain(`# HELP ${name} `);
      expect(out).toContain(`# TYPE ${name} `);
    }
  });
});

describe('createMetrics — opt-in per-principal counter', () => {
  it('is absent by default', () => {
    const m = createMetrics('1.0.0');
    expect(m.toolCallsByPrincipalTotal).toBeUndefined();
    const body = m.registry.render();
    expect(body).not.toContain('triliumnext_mcp_tool_calls_by_principal_total');
  });

  it('is declared when includePrincipal=true', () => {
    const m = createMetrics('1.0.0', { includePrincipal: true });
    expect(m.toolCallsByPrincipalTotal).toBeDefined();
    m.toolCallsByPrincipalTotal!.inc({
      principal: 'alice@example.com',
      tool: 'search_notes',
      ok: 'true',
      error: 'none',
    });
    const body = m.registry.render();
    expect(body).toContain('# HELP triliumnext_mcp_tool_calls_by_principal_total');
    expect(body).toContain(
      'triliumnext_mcp_tool_calls_by_principal_total{principal="alice@example.com",tool="search_notes",ok="true",error="none"} 1'
    );
  });
});

describe('normalizeRoute', () => {
  it('returns canonical names for known paths', () => {
    expect(normalizeRoute('GET', '/health')).toBe('/health');
    expect(normalizeRoute('GET', '/sse')).toBe('/sse');
    expect(normalizeRoute('GET', '/metrics')).toBe('/metrics');
    expect(normalizeRoute('POST', '/message')).toBe('/message');
    expect(normalizeRoute('POST', '/message?sessionId=abc')).toBe('/message');
  });

  it('collapses unknown paths so cardinality stays bounded', () => {
    expect(normalizeRoute('GET', '/some/weird/path')).toBe('GET:unknown');
    expect(normalizeRoute('POST', '/whatever')).toBe('unknown');
  });
});
