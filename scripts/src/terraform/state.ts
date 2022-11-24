import {Id, StateSchema} from './schema'
import {
  Resource,
  ResourceConstructors,
  ResourceConstructor
} from '../resources/resource'
import env from '../env'
import * as cli from '@actions/exec'
import * as fs from 'fs'
import * as core from '@actions/core'
import * as HCL from 'hcl2-parser'
import * as thisModule from './state'

export async function loadState() {
  let source = ''
  if (env.TF_EXEC === 'true') {
    core.info('Loading state from Terraform state file')
    await cli.exec('terraform show -json', undefined, {
      cwd: env.TF_WORKING_DIR,
      listeners: {
        stdout: data => {
          source += data.toString()
        }
      },
      silent: true
    })
  } else {
    source = fs
      .readFileSync(`${env.TF_WORKING_DIR}/terraform.tfstate`)
      .toString()
  }
  return source
}

export class State {
  static async New() {
    return new State(await thisModule.loadState())
  }

  private _ignoredProperties: Record<string, string[]> = {}
  private _ignoredTypes: string[] = []
  private _state?: StateSchema

  private updateIgnoredPropertiesFrom(path: string) {
    if (fs.existsSync(path)) {
      const hcl = HCL.parseToObject(fs.readFileSync(path))?.at(0)
      for (const [name, resource] of Object.entries(hcl?.resource ?? {}) as [
        string,
        any
      ][]) {
        const properties = resource?.this
          ?.at(0)
          ?.lifecycle?.at(0)?.ignore_changes
        if (properties !== undefined) {
          this._ignoredProperties[name] = properties.map((v: string) =>
            v.substring(2, v.length - 1)
          ) // '${v}' -> 'v'
        }
      }
    }
  }

  private updateIgnoredTypesFrom(path: string) {
    if (fs.existsSync(path)) {
      const hcl = HCL.parseToObject(fs.readFileSync(path))?.at(0)
      const types = hcl?.locals?.at(0)?.resource_types
      if (types !== undefined) {
        this._ignoredTypes = ResourceConstructors.map(c => c.StateType).filter(
          t => !types.includes(t)
        )
      }
    }
  }

  private setState(source: string) {
    console.log(source);
    const state = JSON.parse(source, (_k, v) => v ?? undefined)
    if (state.values?.root_module?.resources !== undefined) {
      state.values.root_module.resources = state.values.root_module.resources
        .filter((r: any) => r.mode === 'managed')
        .filter((r: any) => !this._ignoredTypes.includes(r.type))
        .map((r: any) => {
          // TODO: remove nested values
          r.values = Object.fromEntries(
            Object.entries(r.values).filter(
              ([k, _v]) => !this._ignoredProperties[r.type]?.includes(k)
            )
          )
          return r
        })
    }
    this._state = state
  }

  constructor(source: string) {
    this.updateIgnoredPropertiesFrom(`${env.TF_WORKING_DIR}/resources.tf`)
    this.updateIgnoredPropertiesFrom(
      `${env.TF_WORKING_DIR}/resources_override.tf`
    )
    this.updateIgnoredTypesFrom(`${env.TF_WORKING_DIR}/locals.tf`)
    this.updateIgnoredTypesFrom(`${env.TF_WORKING_DIR}/locals_override.tf`)
    this.setState(source)
  }

  async refresh() {
    if (env.TF_EXEC === 'true') {
      await cli.exec(`terraform refresh -lock=${env.TF_LOCK}`, undefined, {
        cwd: env.TF_WORKING_DIR
      })
    }
    this.setState(await thisModule.loadState())
  }

  getAllResources(): Resource[] {
    const resources = []
    for (const resourceClass of ResourceConstructors) {
      const classResources = this.getResources(resourceClass)
      resources.push(...classResources)
    }
    return resources
  }

  getResources<T extends Resource>(resourceClass: ResourceConstructor<T>): T[] {
    if (ResourceConstructors.includes(resourceClass)) {
      return resourceClass.FromState(this._state)
    } else {
      throw new Error(`${resourceClass.name} is not supported`)
    }
  }

  async addResource(id: Id, resource: Resource) {
    if (env.TF_EXEC === 'true') {
      const address = resource.getStateAddress().replaceAll('"', '\\"')
      await cli.exec(
        `terraform import -lock=${env.TF_LOCK} "${address}" "${id}"`,
        undefined,
        {cwd: env.TF_WORKING_DIR}
      )
    }
  }

  async removeResource(resource: Resource) {
    if (env.TF_EXEC === 'true') {
      const address = resource.getStateAddress().replaceAll('"', '\\"')
      await cli.exec(
        `terraform state rm -lock=${env.TF_LOCK} "${address}"`,
        undefined,
        {cwd: env.TF_WORKING_DIR}
      )
    }
  }

  async sync(resources: [Id, Resource][]) {
    const oldResources = this.getAllResources()
    for (const resource of oldResources) {
      if (
        !resources.some(
          ([_i, r]) => r.getStateAddress() === resource.getStateAddress()
        )
      ) {
        await this.removeResource(resource)
      }
    }
    for (const [id, resource] of resources) {
      if (
        !oldResources.some(
          r => r.getStateAddress() === resource.getStateAddress()
        )
      ) {
        await this.addResource(id, resource)
      }
    }
  }
}
