// Bundles the benchmark scripts (which reuse the extension's own modules) into runnable CommonJS.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: {
    run: 'bench/run.ts',
    overhead: 'bench/overhead.ts',
    report: 'bench/report.ts',
  },
  outdir: 'bench/dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['@resvg/resvg-js'],
  sourcemap: 'inline',
  logLevel: 'warning',
});
