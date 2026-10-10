/**
 * Page styles, scoped to the pp- prefix and installed once.
 *
 * Every colour is a harness alias with a literal fallback, so a page rendered
 * in a host that has not published its palette still reads as deliberate.
 */

const STYLE_ID = 'dsh-plugin-patcher-styles'

/*
 * NOTE ON THE CLOSING BACKTICK: it sits on a line of its own with nothing
 * after it. Writing a comma there — the obvious `const CSS = `...`,` — makes
 * rolldown's parser read the template as unterminated and the build fails with
 * "Identifier expected. 'export' is a reserved word" pointing at the first
 * export *below* the string, which names the wrong file and the wrong cause
 * entirely. Keep the closer bare.
 */
/*
 * NOTE ON THE CLOSING BACKTICK: it sits on a line of its own with nothing
 * after it. Writing a comma there — the obvious `const CSS = <ticks>,` — makes
 * rolldown's parser read the template as unterminated, and the build then fails
 * with "Identifier expected. 'export' is a reserved word" pointing at the first
 * export *below* the string: the wrong file and the wrong cause entirely. Keep
 * the closer bare.
 */
const CSS = `
.pp{display:flex;flex-direction:column;gap:14px;padding:2px 0 8px}
.pp__head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:10px}
.pp__title{color:var(--dsw-alias-label-primary,#17191d);font-size:14px;font-weight:600}
.pp__intro{max-width:70ch;color:var(--dsw-alias-label-secondary,#5b6472);font-size:12px;line-height:1.6}
.pp__meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary,#7d8592);font-size:11px}
.pp__banner{display:flex;flex-direction:column;gap:4px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,#d9dde4);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-secondary,#4f5867);font-size:12px;line-height:1.55}
.pp__banner[data-tone='warn']{border-color:var(--dsw-alias-state-warn-primary,#d9a441);color:var(--dsw-alias-label-primary,#17191d)}
.pp__banner[data-tone='bad']{border-color:var(--dsw-alias-state-error-primary,#d64545);color:var(--dsw-alias-label-primary,#17191d)}
.pp__group{display:flex;flex-direction:column;gap:8px}
.pp__group-title{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.pp__card{display:flex;flex-direction:column;gap:8px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:12px;background:var(--dsw-alias-bg-base,#fff)}
.pp__card[data-tone='bad']{border-color:var(--dsw-alias-state-error-primary,#d64545)}
.pp__card[data-tone='warn']{border-color:var(--dsw-alias-state-warn-primary,#d9a441)}
.pp__card--quiet{background:var(--dsw-alias-bg-layer-2,#f7f8fa)}
.pp__card-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}
.pp__card-title{min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary,#17191d);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.pp__card-sub{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:11px}
.pp__patch{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#eceef1)}
.pp__patch:first-of-type{padding-top:0;border-top:0}
.pp__patch-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.pp__patch-id{color:var(--dsw-alias-label-primary,#17191d);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px}
.pp__patch-reason{flex:1 1 220px;min-width:0;color:var(--dsw-alias-label-secondary,#5b6472);font-size:12px;line-height:1.5}
.pp__detail{color:var(--dsw-alias-label-tertiary,#838b98);font-size:11px;line-height:1.55;word-break:break-word}
.pp__chip{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:500;white-space:nowrap}
.pp__chip[data-tone='ok']{background:var(--dsw-alias-state-business-primary-soft,#e8f0fe);color:var(--dsw-alias-state-business-primary,#2f6feb)}
.pp__chip[data-tone='warn']{background:#fdf3e2;color:var(--dsw-alias-state-warn-primary,#a9741a)}
.pp__chip[data-tone='bad']{background:#fdeaea;color:var(--dsw-alias-state-error-primary,#b42318)}
.pp__btn{box-sizing:border-box;min-height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#d8dce3);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#4f5867);font:inherit;font-size:12px;cursor:pointer;transition:background-color .14s ease,border-color .14s ease}
.pp__btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f1f2f4)}
.pp__btn:focus-visible{outline:0;border-color:var(--dsw-alias-state-business-primary,#3b82f6);box-shadow:0 0 0 3px rgb(59 130 246 / 18%)}
.pp__btn:disabled{cursor:default;opacity:.45}
.pp__btn[data-variant='primary']{border-color:transparent;background:var(--dsw-alias-state-business-primary,#3b82f6);color:#fff}
.pp__btn[data-variant='danger']:hover:not(:disabled){background:#fdeaea;color:var(--dsw-alias-state-error-primary,#b42318)}
.pp__form{display:flex;flex-direction:column;gap:10px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2,#d9dde4);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f8fa)}
.pp__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.pp__field{display:flex;flex-direction:column;gap:3px;min-width:0}
.pp__label{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:11px}
.pp__input,.pp__select,.pp__area{box-sizing:border-box;width:100%;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2,#d8dce3);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#17191d);font:inherit;font-size:12px}
.pp__area{min-height:64px;resize:vertical;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1.5}
.pp__input:focus,.pp__select:focus,.pp__area:focus{outline:0;border-color:var(--dsw-alias-state-business-primary,#3b82f6)}
.pp__check{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#4f5867);font-size:12px}
.pp__error{color:var(--dsw-alias-state-error-primary,#b42318);font-size:11px;line-height:1.5}
.pp__hint{color:var(--dsw-alias-label-tertiary,#838b98);font-size:11px;line-height:1.5}
.pp__pre{overflow:auto;margin:0;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,#eef0f3);color:var(--dsw-alias-label-secondary,#4f5867);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all}
.pp__actions{display:flex;flex-wrap:wrap;gap:8px}
.pp__inventory{display:flex;flex-direction:column;gap:4px}
.pp__inv-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:9px}
.pp__inv-label{min-width:0;overflow:hidden;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.pp__summary{display:flex;flex-wrap:wrap;gap:6px}
`

export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
}
