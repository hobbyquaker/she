<script lang="ts">
    import { getConfig, putConfig, brokerRestart } from '../../lib/api.js';

    // ── Props ──────────────────────────────────────────────────────────────────
    interface Props {
        onDone: () => void;
    }
    let { onDone }: Props = $props();

    // ── State ──────────────────────────────────────────────────────────────────
    type Step = 'intro' | 'probe' | 'config' | 'bootstrap' | 'restart' | 'done' | 'manual';
    let step = $state<Step>('intro');
    let error = $state('');
    let loading = $state(false);

    // wizard form values
    let adminUsername = $state('she-admin');
    let adminPassword = $state('');
    let configDir = $state('/etc/mosquitto');

    // result from bootstrap
    let bootstrapResult = $state<{
        adminUsername: string;
        adminPassword: string;
        dynSecPath: string;
        confFilePath: string;
        message: string;
    } | null>(null);

    let restartDone = $state(false);
    let restarting = $state(false);

    // manual path
    let manualUsername = $state('she-admin');
    let manualPassword = $state('');
    let savingManual = $state(false);

    async function probe() {
        loading = true;
        error = '';
        try {
            const res = await fetch('/she/broker/wizard/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            const data = await res.json();
            if (data.active) {
                step = 'done'; // already active
            } else {
                step = 'config';
            }
        } catch (e: any) {
            error = e.message;
        } finally {
            loading = false;
        }
    }

    async function bootstrap() {
        loading = true;
        error = '';
        try {
            const res = await fetch('/she/broker/wizard/bootstrap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUsername, adminPassword: adminPassword || undefined, configDir }),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error ?? 'Bootstrap failed');
            bootstrapResult = data;
            // Save credentials to config.json
            const cfg = await getConfig();
            const broker = ((cfg.broker ?? {}) as Record<string, unknown>);
            await putConfig({
                ...cfg,
                broker: {
                    ...broker,
                    dynsec: {
                        adminUsername: data.adminUsername,
                        adminPassword: data.adminPassword,
                    },
                },
            });
            step = 'restart';
        } catch (e: any) {
            error = e.message;
        } finally {
            loading = false;
        }
    }

    async function restart() {
        restarting = true;
        error = '';
        try {
            await brokerRestart();
            // Give it a moment to come back
            await new Promise((r) => setTimeout(r, 2000));
            restartDone = true;
            step = 'done';
        } catch (e: any) {
            error = e.message;
        } finally {
            restarting = false;
        }
    }

    async function saveManual() {
        savingManual = true;
        error = '';
        try {
            const cfg = await getConfig();
            const broker = ((cfg.broker ?? {}) as Record<string, unknown>);
            await putConfig({
                ...cfg,
                broker: {
                    ...broker,
                    dynsec: {
                        adminUsername: manualUsername,
                        adminPassword: manualPassword,
                    },
                },
            });
            step = 'done';
        } catch (e: any) {
            error = e.message;
        } finally {
            savingManual = false;
        }
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
</script>

<div class="wizard">
    <div class="wizard-header">
        <h3>dynsec Setup Wizard</h3>
        <button class="skip-btn" onclick={() => (step = 'manual')}>Manual setup instead</button>
    </div>

    {#if error}<div class="err">{error}</div>{/if}

    <!-- ── Intro ─────────────────────────────────────────────────────────────── -->
    {#if step === 'intro'}
    <div class="step">
        <p>This wizard will configure the <strong>Mosquitto Dynamic Security plugin</strong> for use with she. It will:</p>
        <ul>
            <li>Create a <code>she-admin</code> service account with a random strong password.</li>
            <li>Write <code>dynamic-security.json</code> to your mosquitto config directory.</li>
            <li>Add the <code>plugin</code> line to <code>mosquitto.conf</code>.</li>
            <li>Ask you to restart mosquitto to activate the plugin.</li>
        </ul>
        <p class="hint">In <strong>remote mode</strong> (SSH host configured), <code>mosquitto_ctrl</code> is invoked on the broker host via SSH. In local mode, it must be installed on this machine. <code>mosquitto_ctrl</code> is part of the <code>mosquitto</code> package.</p>
        <div class="actions">
            <button onclick={() => { step = 'probe'; probe(); }} disabled={loading}>Start</button>
        </div>
    </div>

    <!-- ── Probing ────────────────────────────────────────────────────────────── -->
    {:else if step === 'probe'}
    <div class="step">
        <p>{loading ? 'Probing dynsec…' : 'Checking dynsec status…'}</p>
    </div>

    <!-- ── Config ─────────────────────────────────────────────────────────────── -->
    {:else if step === 'config'}
    <div class="step">
        <p>dynsec is not yet active. Configure bootstrap settings:</p>
        <label>Admin username<input bind:value={adminUsername} /></label>
        <label>Admin password<input type="password" placeholder="(leave blank to auto-generate)" bind:value={adminPassword} /></label>
        <label>Mosquitto config directory<input bind:value={configDir} /></label>
        <div class="actions">
            <button onclick={bootstrap} disabled={loading || !adminUsername}>
                {loading ? 'Bootstrapping…' : 'Bootstrap dynsec'}
            </button>
        </div>
    </div>

    <!-- ── Restart prompt ─────────────────────────────────────────────────────── -->
    {:else if step === 'restart' && bootstrapResult}
    <div class="step">
        <div class="ok-banner">✓ dynsec files written and credentials saved.</div>
        <p>The <code>plugin</code> line has been added to <code>{bootstrapResult.confFilePath}</code>.</p>
        <p>Enabling a new plugin requires a <strong>full mosquitto restart</strong> (not just SIGHUP):</p>
        <div class="actions">
            <button class="btn-warn" onclick={restart} disabled={restarting}>
                {restarting ? 'Restarting…' : 'Restart mosquitto now'}
            </button>
            <button onclick={() => { step = 'done'; }} class="skip-step">Skip (I'll restart manually)</button>
        </div>
        {#if restarting}
        <p class="hint">Restarting mosquitto… this may take a few seconds.</p>
        {/if}
    </div>

    <!-- ── Done ───────────────────────────────────────────────────────────────── -->
    {:else if step === 'done'}
    <div class="step">
        <div class="ok-banner">✓ dynsec is configured and connected.</div>
        <p>she is now managing broker users and ACLs via the Dynamic Security plugin. You can use the <strong>Users & Roles</strong> tab to add users, create roles, and define ACL rules.</p>
        <div class="actions">
            <button class="btn-primary" onclick={onDone}>Done</button>
        </div>
    </div>

    <!-- ── Manual ─────────────────────────────────────────────────────────────── -->
    {:else if step === 'manual'}
    <div class="step">
        <p>Enter the credentials of an existing dynsec admin account:</p>
        <label>Admin username<input bind:value={manualUsername} /></label>
        <label>Admin password<input type="password" bind:value={manualPassword} /></label>
        <div class="actions">
            <button onclick={() => (step = 'intro')}>Back</button>
            <button class="btn-primary" onclick={saveManual} disabled={savingManual || !manualUsername || !manualPassword}>
                {savingManual ? 'Saving…' : 'Save credentials'}
            </button>
        </div>
    </div>
    {/if}
</div>

<style>
    .wizard {
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        max-width: 560px;
        padding: 16px 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .wizard-header {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .wizard-header h3 {
        font-size: 13px;
        font-weight: 600;
        margin: 0;
        color: var(--text, #ddd);
    }

    .skip-btn {
        margin-left: auto;
        background: none;
        border: none;
        color: var(--text-muted, #888);
        cursor: pointer;
        font-size: 11px;
        padding: 2px 0;
        text-decoration: underline;
    }

    .step {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .step p { font-size: 13px; margin: 0; line-height: 1.5; }
    .step ul { font-size: 13px; margin: 0; padding-left: 18px; line-height: 1.6; }
    .step code { background: var(--code-bg, #2a2a2a); border-radius: 3px; font-size: 11px; padding: 1px 4px; }

    label {
        display: flex;
        flex-direction: column;
        font-size: 12px;
        color: var(--text-muted, #aaa);
        gap: 4px;
    }

    input {
        background: var(--input-bg, #2a2a2a);
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text, #eee);
        font-size: 12px;
        padding: 5px 8px;
    }

    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .actions button, .skip-step {
        background: var(--accent-dim, rgba(86,156,214,0.12));
        border: 1px solid rgba(86,156,214,0.3);
        border-radius: 4px;
        color: var(--accent, #569cd6);
        cursor: pointer;
        font-size: 12px;
        padding: 5px 14px;
    }
    .actions button:disabled { opacity: 0.5; cursor: not-allowed; }

    .btn-primary { background: rgba(86,156,214,0.2) !important; border-color: rgba(86,156,214,0.5) !important; }
    .btn-danger { background: rgba(220,60,60,0.12) !important; border: 1px solid rgba(220,60,60,0.3) !important; color: #e88 !important; }
    .btn-warn   { background: rgba(220,140,40,0.12) !important; border: 1px solid rgba(220,140,40,0.3) !important; color: #e8a040 !important; }

    .skip-step {
        background: none !important;
        border: none !important;
        color: var(--text-muted, #888) !important;
        font-size: 11px !important;
        text-decoration: underline;
    }

    .ok-banner { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 4px; color: #8c8; font-size: 12px; padding: 6px 10px; }
    .err { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; }
    .hint { color: var(--text-muted, #888) !important; font-size: 11px !important; }
</style>
