// Un seul paiement (ou ancrage) dépense le portefeuille à la fois.
// Sans ça, deux opérations simultanées prendraient la même pièce → double dépense refusée.
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn)
    this.tail = result.catch(() => undefined)
    return result
  }
}
