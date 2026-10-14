/**
 * cross-cluster/registry-flags.ts
 *
 * Byte flags of the LP-vault registry account the keeper reads (shared by lp-fee-cranker.ts and the
 * P2b feature layer, kept in their own module so neither imports the other).
 */

/**
 * P3 bound-vault flag: `LpVaultRegistryV16._reserved[VAULT_LP_REGISTRY_BOUND_FLAG_IDX = 0]`
 * (struct offset 144 => absolute 160; layout identical on v18.2 6377376a and P3 b2b2559e).
 * 0 = unbound, 1 = bound; any other byte is InvalidAccountData on-chain
 * (`registry_vault_lp_bound`, b2b2559e v16_program.rs:5733), so it is reported, not guessed.
 */
export const LP_VAULT_REGISTRY_BOUND_FLAG_OFF = 16 + 144;
export function lpVaultRegistryBound(data: Uint8Array): boolean {
  if (data.length <= LP_VAULT_REGISTRY_BOUND_FLAG_OFF) return false;
  const b = data[LP_VAULT_REGISTRY_BOUND_FLAG_OFF];
  if (b === 0) return false;
  if (b === 1) return true;
  throw new Error(`LP-vault registry bound flag is ${b} (only 0/1 are valid)`);
}

/**
 * P2b (#526) "VaultLpExtV19 exists" flag: `_reserved[1]`, absolute byte 161 (`isLpVaultRegistryExtP2b`).
 * Once 1, tags 78 (bound), 98 and 97 REQUIRE the ext account (fail closed). It is 0 on every
 * pre-P2b program, so reading it is a no-op there.
 *
 * Unlike the SDK's `isLpVaultRegistryExtP2b` this never throws: a short account or an
 * unexpected byte reads as "no ext", which keeps today's tag-78 account list unchanged on any
 * layout the keeper does not recognise (the on-chain program rejects a bad byte itself).
 */
export const LP_VAULT_REGISTRY_EXT_FLAG_OFF = 16 + 145;
export function lpVaultRegistryExtFlag(data: Uint8Array): boolean {
  return data.length > LP_VAULT_REGISTRY_EXT_FLAG_OFF && data[LP_VAULT_REGISTRY_EXT_FLAG_OFF] === 1;
}
