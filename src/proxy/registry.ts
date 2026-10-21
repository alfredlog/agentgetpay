// Registre des agents : identité, clé d'API, statut et règles de dépense.
// Modifiable pendant que le proxy tourne (page d'administration), sauvegardé dans config/.
// Version entreprise : une base de données (Postgres) avec historique des versions.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Rules } from './policy.js'

export interface AgentRecord {
  id: string
  apiKey?: string   // clés de développement en clair (dev-…), pratiques pour la démo
  keyHash?: string  // clés créées par l'administration : seul le hash est stocké
  keyHint?: string  // les 4 derniers caractères, pour reconnaître la clé
  active?: boolean  // false = agent suspendu
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// Écriture "atomique" : on écrit un fichier temporaire puis on le renomme (pas de fichier à moitié écrit)
const save = (path: string, data: unknown) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2) + '\n')
  renameSync(`${path}.tmp`, path)
}

export class AgentRegistry {
  private agents: AgentRecord[]
  private rules: Record<string, Rules>

  constructor(private agentsPath = 'config/agents.json', private rulesPath = 'config/policies.json') {
    this.agents = JSON.parse(readFileSync(agentsPath, 'utf8'))
    this.rules = JSON.parse(readFileSync(rulesPath, 'utf8'))
  }

  list() { return this.agents.map(a => ({ ...a, active: a.active !== false })) }
  get(id: string) { return this.agents.find(a => a.id === id) }
  rulesFor(id: string): Rules | undefined { return this.rules[id] }
  isActive(id: string) { return this.get(id)?.active !== false }

  // Retrouve l'agent à partir de sa clé d'API (en-tête "Authorization: Bearer …")
  authenticate(authHeader: string | undefined): AgentRecord | undefined {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
    if (!token) return undefined
    const h = sha256(token)
    return this.agents.find(a => (a.keyHash && sameText(a.keyHash, h)) || (a.apiKey && sameText(sha256(a.apiKey), h)))
  }

  setRules(id: string, rules: Rules) {
    this.rules[id] = rules
    save(this.rulesPath, this.rules)
  }

  setActive(id: string, active: boolean) {
    const a = this.get(id)!
    a.active = active
    save(this.agentsPath, this.agents)
  }

  // Nouvelle clé : renvoyée UNE seule fois, seul son hash est gardé
  rotateKey(id: string): string {
    const a = this.get(id)!
    const key = `agp_${randomBytes(24).toString('base64url')}`
    delete a.apiKey
    a.keyHash = sha256(key)
    a.keyHint = key.slice(-4)
    save(this.agentsPath, this.agents)
    return key
  }

  create(id: string, rules: Rules): string {
    this.agents.push({ id, active: true })
    this.rules[id] = rules
    save(this.rulesPath, this.rules)
    return this.rotateKey(id)
  }
}

// Vérifie les règles envoyées par la page d'administration
export function validateRules(input: any): Rules {
  const num = (v: unknown, name: string, min: number) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number ≥ ${min}`)
    if (n > 100000) throw new Error(`${name} is too large`)
    return Math.round(n * 100) / 100
  }
  const domains = (Array.isArray(input?.allowed_domains) ? input.allowed_domains : String(input?.allowed_domains ?? '').split(','))
    .map((d: unknown) => String(d).trim().toLowerCase()).filter(Boolean)
  if (!domains.length) throw new Error('Add at least one allowed domain')
  for (const d of domains) if (!/^[a-z0-9.-]+$/.test(d)) throw new Error(`Invalid domain: ${d}`)
  const rules: Rules = {
    daily_budget_eur: num(input?.daily_budget_eur, 'Daily budget', 0.01),
    max_per_payment_eur: num(input?.max_per_payment_eur, 'Max per payment', 0.01),
    approval_above_eur: num(input?.approval_above_eur, 'Approval threshold', 0),
    allowed_domains: [...new Set<string>(domains)]
  }
  if (rules.max_per_payment_eur > rules.daily_budget_eur) throw new Error('Max per payment cannot be higher than the daily budget')
  return rules
}

export const validAgentId = (id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{2,31}$/.test(id)
