// Entry for the bundled single executable (CommonJS, so no top-level await).
import { main } from './main.js';

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
