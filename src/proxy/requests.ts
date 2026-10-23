// Demandes qui attendent une décision humaine : un achat au-dessus du seuil, ou un mandat (achats récurrents).
//
// Une validation peut prendre des heures ou des jours : la demande est donc ENREGISTRÉE (elle survit à un
// redémarrage), l'agent continue son travail, et dès qu'un humain valide, le proxy exécute l'achat tout seul.
// L'agent récupère ensuite le résultat (check_request), ou reçoit un appel sur son adresse de rappel.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OrderInfo } from '../shared/x402.js'

export type RequestStatus =
  | 'pending'    // en attente d'une décision
  | 'approved'   // validée, exécution en cours
  | 'completed'  // validée et exécutée (achat payé, ou mandat créé)
  | 'rejected'   // refusée par un humain
  | 'expired'    // pas de réponse à temps
  | 'failed'     // validée, mais l'exécution a échoué (prix augmenté, budget épuisé, service en panne…)

export interface MandateTerms {
  domain: string            // marchand (domaine) concerné
  category?: string         // catégorie couverte, ex. "software.subscription"
  maxEurPerMonth: number    // plafond mensuel couvert par le mandat
  months: number            // durée
}

export interface StoredRequest {
  id: string                 // ex. "R-7K2Q9D"
  kind: 'payment' | 'mandate'
  agentId: string
  purpose?: string
  reason: string             // pourquoi une validation est nécessaire
  createdAt: string
  expiresAt: string
  status: RequestStatus
  decidedBy?: string
  decidedAt?: string
  // Achat
  url?: string
  method?: string
  amountSats?: number        // montant validé : l'exécution ne paiera jamais plus
  amountEur?: number
  order?: OrderInfo
  callbackUrl?: string       // l'agent est prévenu ici quand la demande est terminée
  // Mandat
  mandate?: MandateTerms
  // Résultat
  result?: { status: number; contentType: string; paidSats?: number; txid?: string; mandateId?: string; error?: string }
  // Messages de validation envoyés (pour les mettre à jour : Telegram…)
  notices?: Record<string, unknown>
}

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const newId = () => 'R-' + Array.from(randomBytes(6), b => ALPHABET[b % ALPHABET.length]).join('')

export class RequestStore {
  private items: StoredRequest[]
  private file: string

  constructor(private dir = 'data/requests') {
    this.file = join(dir, 'index.json')
    mkdirSync(dir, { recursive: true })
    this.items = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : []
  }

  private save() {
    // On garde 1000 demandes terminées au maximum (les plus récentes)
    const open = this.items.filter(r => r.status === 'pending' || r.status === 'approved')
    const done = this.items.filter(r => r.status !== 'pending' && r.status !== 'approved')
    if (done.length > 1000) for (const r of done.splice(0, done.length - 1000)) this.removeFiles(r.id)
    this.items = [...done, ...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items, null, 2))
    renameSync(`${this.file}.tmp`, this.file)
  }

  private removeFiles(id: string) {
    for (const ext of ['body', 'result']) rmSync(join(this.dir, `${id}.${ext}`), { force: true })
  }

  create(r: Omit<StoredRequest, 'id' | 'createdAt' | 'status'>, body?: unknown): StoredRequest {
    let id = newId()
    while (this.get(id)) id = newId()
    const item: StoredRequest = { ...r, id, createdAt: new Date().toISOString(), status: 'pending' }
    // Le contenu de la requête (parfois un PDF en base64) est gardé à part, pour l'exécution
    if (body !== undefined) writeFileSync(join(this.dir, `${id}.body`), JSON.stringify(body))
    this.items.push(item)
    this.save()
    return item
  }

  get(id: string) { return this.items.find(r => r.id === id) }
  list(filter?: (r: StoredRequest) => boolean) { return filter ? this.items.filter(filter) : [...this.items] }
  open() { return this.items.filter(r => r.status === 'pending') }

  update(id: string, patch: Partial<StoredRequest>) {
    const r = this.get(id)
    if (!r) return undefined
    Object.assign(r, patch)
    this.save()
    return r
  }

  body(id: string): unknown {
    const p = join(this.dir, `${id}.body`)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined
  }

  saveResult(id: string, data: Buffer) { writeFileSync(join(this.dir, `${id}.result`), data) }
  result(id: string): Buffer | undefined {
    const p = join(this.dir, `${id}.result`)
    return existsSync(p) ? readFileSync(p) : undefined
  }
  dropBody(id: string) { rmSync(join(this.dir, `${id}.body`), { force: true }) }
}
