import ts from "typescript";
import { basename, dirname, join, relative, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { PuteredError } from "./errors.js";
import { createHash } from "node:crypto";

interface Declaration { source: string; text: string; extension: string }

// TypeScript can infer relative imports into an external package when the source
// project is CommonJS. Rebind them to a public export before relocating the graph.
function publicSpecifier(file: string, matches: (specifier: string) => boolean): string | undefined {
  let directory = dirname(file);
  while (true) {
    const path = join(directory, "package.json");
    if (ts.sys.fileExists(path)) {
      const pkg = JSON.parse(ts.sys.readFile(path)!);
      if (typeof pkg.name !== "string") {
        const parent = dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
        continue;
      }
      const sameFile = (target: string) => {
        const candidate = resolve(directory, target);
        return candidate === file || candidate.replace(/\.[cm]?js$/, file.endsWith(".d.mts") ? ".d.mts" : file.endsWith(".d.cts") ? ".d.cts" : ".d.ts") === file;
      };
      const targets = (value: unknown): string[] => typeof value === "string" ? [value] :
        value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
      const exports = pkg.exports;
      const entries: [string, unknown][] = exports && typeof exports === "object" && Object.keys(exports).some(key => key.startsWith("."))
        ? Object.entries(exports) : [[".", exports ?? [pkg.types, pkg.typings, pkg.main]]];
      for (const [key, value] of entries) for (const target of targets(value)) {
        if (!key.includes("*") && sameFile(target)) {
          const specifier = key === "." ? pkg.name : pkg.name + key.slice(1);
          if (matches(specifier)) return specifier;
        }
        if (key.includes("*") && target.includes("*")) {
          const [prefix, suffix] = resolve(directory, target).split("*");
          const declarationSuffix = suffix.replace(/\.[cm]?js$/, file.endsWith(".d.mts") ? ".d.mts" : file.endsWith(".d.cts") ? ".d.cts" : ".d.ts");
          for (const ending of [suffix, declarationSuffix]) if (file.startsWith(prefix) && file.endsWith(ending)) {
            const match = file.slice(prefix.length, ending ? -ending.length : undefined);
            const specifier = pkg.name + key.slice(1).replace("*", match);
            if (matches(specifier)) return specifier;
          }
        }
      }
      return undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
/** Emit the local declaration graph; never forward back to the original source. */
export async function pluginDeclarations(entrypoint: string, outfile: string): Promise<void> {
  const entry = resolve(entrypoint);
  const configPath = ts.findConfigFile(dirname(entry), ts.sys.fileExists);
  let project: ts.CompilerOptions = {};
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new PuteredError("Cannot read the plugin TypeScript configuration.", "PACKAGE_INVALID");
    project = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options;
  }
  const options: ts.CompilerOptions = {
    ...project, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true,
    allowJs: true, checkJs: false, noEmit: false, declaration: true, emitDeclarationOnly: true,
    declarationMap: false, sourceMap: false, composite: false, incremental: false,
    outDir: resolve(dirname(outfile), ".declaration-output"),
    rootDir: configPath ? dirname(configPath) : dirname(entry), declarationDir: undefined, outFile: undefined,
  };
  const host = ts.createCompilerHost(options);
  const declarations = new Map<string, Declaration>();
  host.writeFile = (file, text, _bom, _error, sources) => {
    if (!sources?.length || !/\.d\.[cm]?ts$/.test(file)) return;
    const source = resolve(sources[0].fileName);
    declarations.set(source, { source, text, extension: file.endsWith(".d.mts") ? ".d.mts" : file.endsWith(".d.cts") ? ".d.cts" : ".d.ts" });
  };
  let program = ts.createProgram([entry], options, host);
  let root = options.rootDir!;
  for (const source of program.getSourceFiles()) {
    if (!source.isDeclarationFile && !program.isSourceFileFromExternalLibrary(source)) {
      while (relative(root, resolve(source.fileName)).startsWith("..")) root = dirname(root);
    }
  }
  if (root !== options.rootDir) {
    options.rootDir = root;
    program = ts.createProgram([entry], options, host);
  }
  const emit = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics].filter(item => item.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length) {
    const message = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
    });
    throw new PuteredError(`Plugin declaration generation failed:\n${message}`, "PACKAGE_INVALID");
  }
  // Local hand-authored .d.ts dependencies are not emitted by TypeScript.
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile && !program.isSourceFileDefaultLibrary(file) && !program.isSourceFileFromExternalLibrary(file)) {
      declarations.set(resolve(file.fileName), { source: resolve(file.fileName), text: file.text,
        extension: file.fileName.endsWith(".d.mts") ? ".d.mts" : file.fileName.endsWith(".d.cts") ? ".d.cts" : ".d.ts" });
    }
  }
  if (!declarations.has(entry)) throw new PuteredError("No declaration was emitted for the plugin entrypoint.", "PACKAGE_INVALID");
  const folder = `${basename(outfile, ".mjs")}.types`;
  const names = new Map([...declarations.keys()].sort().map((source, index) => [source, `module-${index}${declarations.get(source)!.extension}`]));
  const runtimeName = (name: string) => name.replace(/\.d\.mts$/, ".mjs").replace(/\.d\.cts$/, ".cjs").replace(/\.d\.ts$/, ".js");
  const texts = new Map<string, string>();
  for (const declaration of declarations.values()) {
    const parsed = ts.createSourceFile(`declaration${declaration.extension}`, declaration.text, ts.ScriptTarget.Latest, true);
    parsed.impliedNodeFormat = declaration.extension === ".d.cts" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
    const edits: { start: number; end: number; text: string }[] = [];
    for (const reference of parsed.referencedFiles) {
      const target = names.get(resolve(dirname(declaration.source), reference.fileName));
      if (!target) throw new PuteredError(`Cannot package declaration reference ${reference.fileName}.`, "PACKAGE_INVALID");
      edits.push({ start: reference.pos, end: reference.end, text: `./${target}` });
    }
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node)) {
        const parent = node.parent;
        const importPath = (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
          (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) || ts.isExternalModuleReference(parent) ||
          (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent));
        if (importPath) {
          const mode = ts.getModeForUsageLocation(parsed, node, options);
          const resolved = ts.resolveModuleName(node.text, declaration.source, options, host, undefined, undefined, mode).resolvedModule;
          const target = resolved && names.get(resolve(resolved.resolvedFileName));
          if (target) edits.push({ start: node.getStart(parsed), end: node.getEnd(), text: JSON.stringify(`./${runtimeName(target)}`) });
          else if (node.text.startsWith(".")) {
            const external = resolved && publicSpecifier(resolve(resolved.resolvedFileName), specifier => {
              const target = ts.resolveModuleName(specifier, declaration.source, options, host, undefined, undefined, mode).resolvedModule;
              return !!target && resolve(target.resolvedFileName) === resolve(resolved.resolvedFileName);
            });
            if (!external) throw new PuteredError(`Cannot package declaration dependency ${node.text}.`, "PACKAGE_INVALID");
            edits.push({ start: node.getStart(parsed), end: node.getEnd(), text: JSON.stringify(external) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    let text = declaration.text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    texts.set(names.get(declaration.source)!, text);
  }
  const generation = createHash("sha256").update(JSON.stringify([...texts].sort())).digest("hex").slice(0, 20);
  const directory = join(dirname(resolve(outfile)), folder, generation);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  for (const [name, text] of texts) await writeFile(join(directory, name), text);
  const entryModule = runtimeName(names.get(entry)!);
  await writeFile(outfile.replace(/\.mjs$/, ".d.mts"), `// Portable declarations; distribute the ${folder}/ directory with this file.\nexport { default } from ${JSON.stringify(`./${folder}/${generation}/${entryModule}`)};\n`);
}
