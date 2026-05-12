/**
 * Tiny Prometheus-compatible metrics registry. Hand-rolled to keep the
 * dependency tree small — the exposition format is short enough to emit
 * by hand and we only need three series types.
 */

type LabelMap = Record<string, string>;

interface SeriesEntry<T> {
  labels: LabelMap;
  labelKey: string;
  value: T;
}

abstract class Metric<T> {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  protected readonly series = new Map<string, SeriesEntry<T>>();

  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
      throw new Error(`invalid metric name: ${name}`);
    }
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  abstract readonly type: 'counter' | 'gauge' | 'histogram';

  protected key(labels: LabelMap): string {
    // Order matters for the key; pin to declared labelNames so {a,b} === {b,a}.
    if (this.labelNames.length === 0) return '';
    return this.labelNames.map((n) => `${n}="${labels[n] ?? ''}"`).join(',');
  }

  protected ensureLabelShape(labels: LabelMap): LabelMap {
    if (this.labelNames.length === 0) return {};
    const out: LabelMap = {};
    for (const name of this.labelNames) {
      out[name] = labels[name] ?? '';
    }
    return out;
  }

  /** Emit zero or more `name{...} value` lines for this metric. */
  abstract render(): string;
}

export class Counter extends Metric<number> {
  readonly type = 'counter' as const;

  inc(labels: LabelMap = {}, delta = 1): void {
    if (delta < 0) throw new Error('Counter.inc delta must be non-negative');
    const shape = this.ensureLabelShape(labels);
    const k = this.key(shape);
    const existing = this.series.get(k);
    if (existing) {
      existing.value += delta;
    } else {
      this.series.set(k, { labels: shape, labelKey: k, value: delta });
    }
  }

  render(): string {
    if (this.series.size === 0) return '';
    const lines: string[] = [];
    for (const entry of this.series.values()) {
      lines.push(`${this.name}${formatLabels(entry.labels)} ${formatNumber(entry.value)}`);
    }
    return lines.join('\n');
  }
}

export class Gauge extends Metric<number> {
  readonly type = 'gauge' as const;

  set(labels: LabelMap, value: number): void;
  set(value: number): void;
  set(a: LabelMap | number, b?: number): void {
    const labels: LabelMap = typeof a === 'number' ? {} : a;
    const value = typeof a === 'number' ? a : (b as number);
    const shape = this.ensureLabelShape(labels);
    const k = this.key(shape);
    this.series.set(k, { labels: shape, labelKey: k, value });
  }

  inc(labels: LabelMap = {}, delta = 1): void {
    const shape = this.ensureLabelShape(labels);
    const k = this.key(shape);
    const existing = this.series.get(k);
    this.series.set(k, { labels: shape, labelKey: k, value: (existing?.value ?? 0) + delta });
  }

  dec(labels: LabelMap = {}, delta = 1): void {
    this.inc(labels, -delta);
  }

  render(): string {
    if (this.series.size === 0) return '';
    const lines: string[] = [];
    for (const entry of this.series.values()) {
      lines.push(`${this.name}${formatLabels(entry.labels)} ${formatNumber(entry.value)}`);
    }
    return lines.join('\n');
  }
}

interface HistogramEntry {
  /** Cumulative bucket counts (le bucket boundaries are the registry's `buckets`). */
  bucketCounts: number[];
  count: number;
  sum: number;
}

export class Histogram extends Metric<HistogramEntry> {
  readonly type = 'histogram' as const;
  /** Bucket upper bounds in seconds. `+Inf` is implicit. */
  readonly buckets: readonly number[];

  constructor(name: string, help: string, labelNames: readonly string[], buckets: readonly number[]) {
    super(name, help, labelNames);
    // Strictly increasing, finite, positive.
    for (let i = 1; i < buckets.length; i++) {
      if (!(buckets[i] > buckets[i - 1])) {
        throw new Error(`histogram buckets must be strictly increasing: ${buckets.join(',')}`);
      }
    }
    this.buckets = buckets;
  }

  observe(labels: LabelMap, value: number): void;
  observe(value: number): void;
  observe(a: LabelMap | number, b?: number): void {
    const labels: LabelMap = typeof a === 'number' ? {} : a;
    const value = typeof a === 'number' ? a : (b as number);
    if (!Number.isFinite(value) || value < 0) return;
    const shape = this.ensureLabelShape(labels);
    const k = this.key(shape);
    let entry = this.series.get(k);
    if (!entry) {
      entry = {
        labels: shape,
        labelKey: k,
        value: {
          bucketCounts: new Array(this.buckets.length).fill(0),
          count: 0,
          sum: 0,
        },
      };
      this.series.set(k, entry);
    }
    entry.value.count += 1;
    entry.value.sum += value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.value.bucketCounts[i] += 1;
      }
    }
  }

  render(): string {
    if (this.series.size === 0) return '';
    const lines: string[] = [];
    for (const entry of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const bucketLabels: LabelMap = { ...entry.labels, le: formatNumber(this.buckets[i]) };
        lines.push(`${this.name}_bucket${formatLabels(bucketLabels)} ${entry.value.bucketCounts[i]}`);
      }
      const infLabels: LabelMap = { ...entry.labels, le: '+Inf' };
      lines.push(`${this.name}_bucket${formatLabels(infLabels)} ${entry.value.count}`);
      lines.push(`${this.name}_sum${formatLabels(entry.labels)} ${formatNumber(entry.value.sum)}`);
      lines.push(`${this.name}_count${formatLabels(entry.labels)} ${entry.value.count}`);
    }
    return lines.join('\n');
  }
}

export class Registry {
  private readonly metrics: Metric<unknown>[] = [];

  register<M extends Metric<unknown>>(metric: M): M {
    if (this.metrics.some((m) => m.name === metric.name)) {
      throw new Error(`metric already registered: ${metric.name}`);
    }
    this.metrics.push(metric);
    return metric;
  }

  /** Render the entire registry in Prometheus text format. */
  render(): string {
    const out: string[] = [];
    for (const m of this.metrics) {
      const body = m.render();
      if (body.length === 0) {
        // Still emit HELP/TYPE so a fresh process advertises its surface.
        out.push(`# HELP ${m.name} ${escapeHelp(m.help)}`);
        out.push(`# TYPE ${m.name} ${m.type}`);
        continue;
      }
      out.push(`# HELP ${m.name} ${escapeHelp(m.help)}`);
      out.push(`# TYPE ${m.name} ${m.type}`);
      out.push(body);
    }
    return out.join('\n') + '\n';
  }
}

function escapeHelp(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: LabelMap): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${k}="${escapeLabelValue(labels[k])}"`);
  }
  return `{${parts.join(',')}}`;
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  // Integers and small floats render cleanly via String(); avoid 1e21 surprises by
  // letting JS do its default which Prometheus accepts.
  return String(n);
}

/**
 * Canonical set of series exposed by the server. Centralized so call sites
 * stay typo-free and so tests can assert against an explicit surface.
 */
export interface Metrics {
  registry: Registry;
  buildInfo: Gauge;
  httpRequestsTotal: Counter;
  httpRequestDuration: Histogram;
  toolCallsTotal: Counter;
  toolCallDuration: Histogram;
  /**
   * Opt-in per-principal counter. Only declared when
   * `createMetrics(version, { includePrincipal: true })` — keeps cardinality
   * bounded by default (one series-tuple per tool×ok×error instead of times
   * principals).
   */
  toolCallsByPrincipalTotal?: Counter;
  sseSessions: Gauge;
  sseConnectsTotal: Counter;
  sseClosesTotal: Counter;
  sseConnectFailuresTotal: Counter;
  processUptimeSeconds: Gauge;
  processResidentMemoryBytes: Gauge;
  /** Sync uptime/memory gauges from process state. Call once at scrape time. */
  collectProcess(): void;
}

export interface CreateMetricsOptions {
  /**
   * If true, declare per-principal counters. Only enable when you trust the
   * principal namespace to be bounded (e.g., a known user list from your IdP).
   * Cardinality scales as principals × tools × outcomes.
   */
  includePrincipal?: boolean;
}

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const TOOL_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export function createMetrics(version: string, opts: CreateMetricsOptions = {}): Metrics {
  const registry = new Registry();

  const buildInfo = registry.register(
    new Gauge('triliumnext_mcp_build_info', 'Build information; constant 1, version in label.', ['version'])
  );
  buildInfo.set({ version }, 1);

  const httpRequestsTotal = registry.register(
    new Counter(
      'triliumnext_mcp_http_requests_total',
      'Total HTTP requests served by the SSE gateway, by route and status.',
      ['method', 'path', 'status']
    )
  );

  const httpRequestDuration = registry.register(
    new Histogram(
      'triliumnext_mcp_http_request_duration_seconds',
      'HTTP request latency in seconds.',
      ['method', 'path'],
      HTTP_BUCKETS
    )
  );

  const toolCallsTotal = registry.register(
    new Counter(
      'triliumnext_mcp_tool_calls_total',
      'Total MCP tool invocations.',
      ['tool', 'ok', 'error']
    )
  );

  const toolCallDuration = registry.register(
    new Histogram(
      'triliumnext_mcp_tool_call_duration_seconds',
      'MCP tool invocation duration in seconds.',
      ['tool'],
      TOOL_BUCKETS
    )
  );

  const toolCallsByPrincipalTotal = opts.includePrincipal
    ? registry.register(
        new Counter(
          'triliumnext_mcp_tool_calls_by_principal_total',
          'Per-principal tool invocation counter. Cardinality scales with principals × tools.',
          ['principal', 'tool', 'ok', 'error']
        )
      )
    : undefined;

  const sseSessions = registry.register(
    new Gauge('triliumnext_mcp_sse_sessions', 'Currently open SSE sessions.')
  );
  sseSessions.set(0);

  const sseConnectsTotal = registry.register(
    new Counter('triliumnext_mcp_sse_connects_total', 'Total successful SSE connection setups.')
  );

  const sseClosesTotal = registry.register(
    new Counter('triliumnext_mcp_sse_closes_total', 'Total SSE connections closed by either side.')
  );

  const sseConnectFailuresTotal = registry.register(
    new Counter(
      'triliumnext_mcp_sse_connect_failures_total',
      'Total SSE connection attempts rejected, by reason.',
      ['reason']
    )
  );

  const processUptimeSeconds = registry.register(
    new Gauge('triliumnext_mcp_process_uptime_seconds', 'Seconds since process start.')
  );

  const processResidentMemoryBytes = registry.register(
    new Gauge('triliumnext_mcp_process_resident_memory_bytes', 'Resident set size of the Node process in bytes.')
  );

  const collectProcess = (): void => {
    processUptimeSeconds.set(process.uptime());
    processResidentMemoryBytes.set(process.memoryUsage().rss);
  };

  return {
    registry,
    buildInfo,
    httpRequestsTotal,
    httpRequestDuration,
    toolCallsTotal,
    toolCallDuration,
    toolCallsByPrincipalTotal,
    sseSessions,
    sseConnectsTotal,
    sseClosesTotal,
    sseConnectFailuresTotal,
    processUptimeSeconds,
    processResidentMemoryBytes,
    collectProcess,
  };
}

/** Path label normalization — keep cardinality bounded. */
export function normalizeRoute(method: string, path: string): string {
  if (path === '/health') return '/health';
  if (path === '/sse') return '/sse';
  if (path === '/metrics') return '/metrics';
  if (path === '/message' || path.startsWith('/message')) return '/message';
  if (path === '/mcp' || path.startsWith('/mcp?')) return '/mcp';
  return method === 'GET' ? 'GET:unknown' : 'unknown';
}
