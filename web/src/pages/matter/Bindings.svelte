<script lang="ts">
    let { active = false }: { active?: boolean } = $props();
</script>

<div class="placeholder">
    <p>Bindings — switch-to-device bindings are configured here (coming with M14).</p>
    {#if active}<p class="dim">Nothing to show yet.</p>{/if}
</div>

<style>
    .placeholder { padding: 16px; color: var(--fg); font-size: 13px; }
    .dim { color: var(--fg-muted); }
</style>
