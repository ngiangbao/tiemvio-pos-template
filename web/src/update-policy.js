// Never reload a transaction, form, failed mutation or running AI tool.
export function canApplyUpdate(s,modalOpen=false){
 return !s.busy&&!s.syncing&&!s.editing&&!s.pending&&!s.mutationRetry&&!(s.cart||[]).length&&!modalOpen
  &&!s.ai?.busy&&!s.ai?.pending&&!s.ai?.unsaved&&!(s.ai?.draft||'').trim();
}
