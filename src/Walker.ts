import * as fs from 'fs-extra';
import * as path from 'path';

export type VersionRange = string;
export interface PackageJSON {
  dependencies: { [name: string]: VersionRange }
  devDependencies: { [name: string]: VersionRange }
  optionalDependencies: { [name: string]: VersionRange }
}

export class Walker {
  private rootModule: string;
  private prodPaths: Set<string> = new Set();

  constructor(modulePath: string) {
    this.rootModule = modulePath;
  }

  private relativeModule(rootPath: string, moduleName: string) {
    return path.resolve(rootPath, 'node_modules', moduleName);
  }

  private async loadPackageJSON(modulePath: string): Promise<PackageJSON | null> {
    const pJPath = path.resolve(modulePath, 'package.json');
    if (await fs.pathExists(pJPath)) {
      return await fs.readJson(pJPath);
    }
    return null;
  }

  private async loadProductionDependenciesForModuleInModule(moduleName: string, modulePath: string, allowMissing = false) {
    let testPath = modulePath;
    let discoveredPath: string | null = null;
    let lastRelative: string | null = null;
    // Try find it while searching recursively up the tree
    while (!discoveredPath && this.relativeModule(testPath, moduleName) !== lastRelative) {
      lastRelative = this.relativeModule(testPath, moduleName);
      if (await fs.pathExists(lastRelative)) {
        discoveredPath = lastRelative;
      } else {
        if (path.basename(path.dirname(testPath)) !== 'node_modules') {
          testPath = path.dirname(testPath);
        }
        testPath = path.dirname(path.dirname(testPath));
      }
    }
    // If we can't find it the install is probably buggered
    if (!discoveredPath && !allowMissing) {
      throw new Error(
        `Failed to locate module "${moduleName}" from "${modulePath}"

        This normally means that either you have deleted this package already somehow (check your ignore settings if using electron-packager).  Or your module installation failed.`
      );
    }
    // If we can find it let's do the same thing for that module
    if (discoveredPath) {
      await this.loadProductionDependenciesForModule(discoveredPath, allowMissing);
    }
  }

  private async loadProductionDependenciesForModule(modulePath: string, allowMissing = false) {
    // We have already traversed this module
    if (this.prodPaths.has(modulePath)) return;

    // Record this module as a production dependency
    this.prodPaths.add(modulePath);
    const pJ = await this.loadPackageJSON(modulePath);
    // If the module doesn't have a package.json file it is probably a
    // dead install from yarn (they dont clean up for some reason)
    if (!pJ) return;

    // For every prod dep
    for (const moduleName in pJ.dependencies) {
      await this.loadProductionDependenciesForModuleInModule(
        moduleName,
        modulePath,
        allowMissing
      );
    }

    // For every optional dep
    // (we do this to be safe but could be smarted about it later)
    for (const moduleName in pJ.optionalDependencies) {
      await this.loadProductionDependenciesForModuleInModule(
        moduleName,
        modulePath,
        true
      );
    }
  }

  async loadProductionDependencies() {
    this.prodPaths = new Set();
    await this.loadProductionDependenciesForModule(this.rootModule);
    return this.prodPaths;
  }

  async pruneModule(modulePath: string) {
    if (this.prodPaths.has(modulePath)) {
      const nodeModulesPath = path.resolve(modulePath, 'node_modules');
      if (!await fs.pathExists(nodeModulesPath)) return;

      for (const subModuleName of await fs.readdir(nodeModulesPath)) {
        if (subModuleName.startsWith('@')) {
          for (const subScopedModuleName of await fs.readdir(path.resolve(nodeModulesPath, subModuleName))) {
            await this.pruneModule(path.resolve(nodeModulesPath, subModuleName, subScopedModuleName));
          }
        } else {
          await this.pruneModule(path.resolve(nodeModulesPath, subModuleName));
        }
      }
    } else {
      await fs.remove(modulePath);
    }
  }

  async prune() {
    await this.loadProductionDependencies();
    await this.pruneModule(this.rootModule);
  }

  private getNearestModuleDirectory(tPath: string) {
    while (!fs.statSync(tPath).isDirectory() || !fs.existsSync(path.resolve(tPath, 'package.json'))) {
      tPath = path.dirname(tPath);
    }
    return tPath;
  }

  async getFsCopyIgnoreFunction() {
    await this.loadProductionDependencies();
    const prodPaths = this.prodPaths;
    const nmPath = path.resolve(this.rootModule, 'node_modules');
    return (tPath: string) => {
      const dirPath = this.getNearestModuleDirectory(tPath);
      if (tPath.indexOf(nmPath) === 0) {
        return !prodPaths.has(dirPath);
      }
      return false;
    };
  }
}
