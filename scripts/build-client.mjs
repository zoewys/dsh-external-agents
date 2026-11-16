import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
const result = await build({
  entryPoints:['src/client/setup.jsx'], bundle:true, external:['react'], platform:'browser',
  target:'chrome120', format:'cjs', write:false,
})
await writeFile('dist/client.js',
  "window.__ModuleLoader__.load({id:'dsh-external-agents',factory:(require)=>{var module={exports:{}};var exports=module.exports;\n"
  + result.outputFiles[0].text + '\nreturn module.exports;}});\n')
