// Accès en lecture au tableau de bord : l'administrateur crée un code pour chaque personne autorisée
// (comptable, direction…). Le code permet de VOIR le tableau de bord et de télécharger les exports,
// pas de modifier les agents. Seul le hash du code est stocké ; on peut le révoquer à tout moment.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface Viewer {
  id: string
  name: string
  keyHash: string
  keyHint: string // les 4 derniers caractères, pour reconnaître le code
  createdAt: string
  createdBy: string
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export class ViewerStore {
  private viewers: Viewer[]

  constructor(private path = 'config/viewers.json') {
    this.viewers = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.viewers, null, 2) + '\n')
    renameSync(`${this.path}.tmp`, this.path)
  }

  list() { return this.viewers.map(({ keyHash, ...v }) => v) }

  // Nouveau code : renvoyé UNE seule fois
  create(name: string, createdBy: string): { viewer: Omit<Viewer, 'keyHash'>; code: string } {
    const code = `agv_${randomBytes(18).toString('base64url')}`
    const v: Viewer = {
      id: randomBytes(6).toString('hex'), name, keyHash: sha256(code), keyHint: code.slice(-4),
      createdAt: new Date().toISOString(), createdBy
    }
    this.viewers.push(v)
    this.save()
    const { keyHash, ...viewer } = v
    return { viewer, code }
  }

  revoke(id: string): Viewer | undefined {
    const v = this.viewers.find(x => x.id === id)
    if (!v) return undefined
    this.viewers = this.viewers.filter(x => x.id !== id)
    this.save()
    return v
  }

  authenticate(code: string): Viewer | undefined {
    if (!code.startsWith('agv_')) return undefined
    const h = sha256(code)
    return this.viewers.find(v => sameText(v.keyHash, h))
  }
}

export const validViewerName = (n: unknown) => typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 40
