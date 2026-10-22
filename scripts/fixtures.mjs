// Generates the harness media. Ads are solid red so a screenshot can prove none was
// visible; content is grayscale test pattern (no red anywhere) with a running counter.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';

const out = fileURLToPath(new URL('../test/e2e/harness/media/', import.meta.url));
const v = ['-c:v', 'libvpx', '-b:v', '120k', '-g', '15', '-auto-alt-ref', '0'];
const a = ['-c:a', 'libopus', '-b:a', '24k'];
const run = (args) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...args]);

const red = (secs, hz) => ['-f', 'lavfi', '-i', `color=c=red:s=320x180:r=30:d=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}`];
const gray = (secs) => ['-f', 'lavfi', '-i', `testsrc=s=320x180:r=30:d=${secs},format=gray,format=yuv420p`, '-f', 'lavfi', '-i', `sine=frequency=220:duration=${secs}`];

run([...red(15, 880), ...v, ...a, '-shortest', out + 'ad15.webm']);
run([...red(8, 660), ...v, ...a, '-shortest', out + 'ad8.webm']);
run([...gray(60), ...v, ...a, '-shortest', out + 'content.webm']);
// Server-stitched simulation: 15 s of ad followed by 45 s of content in one file.
run([...red(15, 880), ...gray(45), '-filter_complex', '[0:v][1:a][2:v][3:a]concat=n=2:v=1:a=1[v][a]', '-map', '[v]', '-map', '[a]', ...v, ...a, out + 'stitched.webm']);
console.log('fixtures written to', out);
