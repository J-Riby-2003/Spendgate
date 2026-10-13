import { createContext, useContext, useState, type ReactNode } from 'react';

// Language order is fixed; every dict entry is an array in this order.
export const LANGS = ['en', 'de', 'fr', 'es', 'it', 'pt', 'ja', 'zh'] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_LABELS: Record<Lang, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  pt: 'Português',
  ja: '日本語',
  zh: '简体中文',
};

type Dict = Record<string, string[]>;

const D: Dict = {
  'notification.failed': ['Phone notification failed', 'Telefonbenachrichtigung fehlgeschlagen', 'Échec de la notification téléphone', 'Falló la notificación al teléfono', 'Notifica al telefono non riuscita', 'Falha na notificação ao telefone', '電話通知に失敗しました', '手机通知发送失败'],
  'notification.retry': ['Phone notification failed; retry scheduled', 'Telefonbenachrichtigung fehlgeschlagen; erneuter Versuch geplant', 'Notification téléphone échouée ; nouvelle tentative prévue', 'Notificación fallida; reintento programado', 'Notifica non riuscita; nuovo tentativo programmato', 'Falha na notificação; nova tentativa agendada', '電話通知に失敗しました。再試行を予定しています', '手机通知发送失败；已安排重试'],
  // nav
  'nav.overview': ['Overview', 'Übersicht', 'Aperçu', 'Resumen', 'Panoramica', 'Visão geral', '概要', '概览'],
  'nav.approvals': ['Approvals', 'Genehmigungen', 'Approbations', 'Aprobaciones', 'Approvazioni', 'Aprovações', '承認', '审批'],
  'nav.agents': ['Agents & Policy', 'Agenten & Richtlinie', 'Agents et politique', 'Agentes y política', 'Agenti e policy', 'Agentes e política', 'エージェントとポリシー', '代理与策略'],
  'nav.ledger': ['Audit Ledger', 'Prüfhauptbuch', "Registre d'audit", 'Registro de auditoría', 'Registro di audit', 'Livro de auditoria', '監査台帳', '审计账本'],

  // page titles + subs
  'page.overview.title': ['Spend overview', 'Ausgabenübersicht', 'Aperçu des dépenses', 'Resumen de gastos', 'Panoramica delle spese', 'Visão geral de gastos', '支出概要', '支出概览'],
  'page.overview.sub': ['Operations', 'Operationen', 'Opérations', 'Operaciones', 'Operazioni', 'Operações', '運用', '运营'],
  'page.approvals.title': ['Approval queue', 'Genehmigungswarteschlange', "File d'attente des approbations", 'Cola de aprobaciones', 'Coda di approvazione', 'Fila de aprovações', '承認キュー', '审批队列'],
  'page.approvals.sub': ['Escalations', 'Eskalationen', 'Escalades', 'Escalaciones', 'Escalazioni', 'Escaladas', 'エスカレーション', '升级事项'],
  'page.agents.title': ['Agents & policy', 'Agenten & Richtlinie', 'Agents et politique', 'Agentes y política', 'Agenti e policy', 'Agentes e política', 'エージェントとポリシー', '代理与策略'],
  'page.agents.sub': ['Policy', 'Richtlinie', 'Politique', 'Política', 'Policy', 'Política', 'ポリシー', '策略'],
  'page.ledger.title': ['Signed ledger', 'Signiertes Hauptbuch', 'Registre signé', 'Registro firmado', 'Registro firmato', 'Livro assinado', '署名済み台帳', '已签名账本'],
  'page.ledger.sub': ['Audit trail', 'Prüfpfad', "Piste d'audit", 'Rastro de auditoría', 'Traccia di audit', 'Trilha de auditoria', '監査証跡', '审计轨迹'],

  // header right-side counts (use {n} and {status} placeholders)
  'header.agentsCount': ['{n} agents under management', '{n} Agenten unter Verwaltung', '{n} agents sous gestion', '{n} agentes bajo gestión', '{n} agenti gestiti', '{n} agentes sob gestão', '管理対象エージェント {n} 件', '管理中的代理 {n} 个'],
  'header.pending': ['{n} pending', '{n} ausstehend', '{n} en attente', '{n} pendientes', '{n} in attesa', '{n} pendentes', '保留中 {n}', '待处理 {n}'],
  'header.entries': ['{n} entries', '{n} Einträge', '{n} entrées', '{n} entradas', '{n} voci', '{n} entradas', '{n} 件のエントリ', '{n} 条记录'],
  'header.ledgerChain': ['{n} ledger entries · chain {status}', '{n} Einträge · Kette {status}', '{n} entrées · chaîne {status}', '{n} entradas · cadena {status}', '{n} voci · catena {status}', '{n} entradas · cadeia {status}', '{n} 件のエントリ · チェーン {status}', '{n} 条记录 · 链 {status}'],
  'status.verified': ['verified', 'bestätigt', 'vérifiée', 'verificada', 'verificata', 'verificada', '確認済み', '已验证'],
  'status.broken': ['broken', 'unterbrochen', 'cassée', 'rota', 'rotta', 'quebrada', '破損', '已断裂'],

  // buttons
  'btn.savePolicy': ['Save policy', 'Richtlinie speichern', 'Enregistrer la politique', 'Guardar política', 'Salva policy', 'Salvar política', 'ポリシーを保存', '保存策略'],
  'btn.registerAgent': ['Register agent', 'Agent registrieren', "Enregistrer l'agent", 'Registrar agente', 'Registra agente', 'Registrar agente', 'エージェントを登録', '注册代理'],
  'btn.register': ['Register', 'Registrieren', 'Enregistrer', 'Registrar', 'Registra', 'Registrar', '登録', '注册'],
  'btn.close': ['Close', 'Schließen', 'Fermer', 'Cerrar', 'Chiudi', 'Fechar', '閉じる', '关闭'],
  'btn.cancel': ['Cancel', 'Abbrechen', 'Annuler', 'Cancelar', 'Annulla', 'Cancelar', 'キャンセル', '取消'],
  'btn.confirm': ['Confirm', 'Bestätigen', 'Confirmer', 'Confirmar', 'Conferma', 'Confirmar', '確認', '确认'],
  'btn.remove': ['Remove', 'Entfernen', 'Supprimer', 'Eliminar', 'Rimuovi', 'Remover', '削除', '移除'],
  'btn.removeAgent': ['Remove agent', 'Agent entfernen', "Supprimer l'agent", 'Eliminar agente', 'Rimuovi agente', 'Remover agente', 'エージェントを削除', '删除代理'],
  'btn.approve': ['Approve', 'Genehmigen', 'Approuver', 'Aprobar', 'Approva', 'Aprovar', '承認', '批准'],
  'btn.reject': ['Reject', 'Ablehnen', 'Rejeter', 'Rechazar', 'Rifiuta', 'Rejeitar', '却下', '拒绝'],
  'btn.exportCsv': ['Export CSV', 'CSV exportieren', 'Exporter CSV', 'Exportar CSV', 'Esporta CSV', 'Exportar CSV', 'CSV を出力', '导出 CSV'],
  'btn.exportJson': ['Export JSON', 'JSON exportieren', 'Exporter JSON', 'Exportar JSON', 'Esporta JSON', 'Exportar JSON', 'JSON を出力', '导出 JSON'],

  // field labels
  'label.dailyBudget': ['Daily budget', 'Tagesbudget', 'Budget journalier', 'Presupuesto diario', 'Budget giornaliero', 'Orçamento diário', '日次予算', '每日预算'],
  'label.autoApprove': ['Auto-approve ceiling / tx', 'Automatische Freigabe / Transaktion', 'Plafond auto / transaction', 'Tope autoaprobación / transacción', 'Soglia auto-approvazione / transazione', 'Teto de autoaprov. / transação', '自動承認上限 / 取引', '自动批准上限 / 笔'],
  'label.humanApproval': ['Human-approval threshold', 'Manuelle Freigabeschwelle', "Seuil d'approbation humaine", 'Umbral de aprobación humana', 'Soglia approvazione umana', 'Limite de aprovação humana', '手動承認のしきい値', '人工审批阈值'],
  'label.blockedVendors': ['Blocked vendors (comma-separated)', 'Blockierte Anbieter (kommagetrennt)', 'Fournisseurs bloqués (séparés par virgules)', 'Proveedores bloqueados (separados por comas)', 'Fornitori bloccati (separati da virgole)', 'Fornecedores bloqueados (separados por vírgulas)', 'ブロック済みベンダー（カンマ区切り）', '已屏蔽供应商（逗号分隔）'],
  'label.allowedDays': ['Allowed days', 'Erlaubte Tage', 'Jours autorisés', 'Días permitidos', 'Giorni consentiti', 'Dias permitidos', '許可された曜日', '允许的天'],
  'label.newVendors': ['New vendors need my yes', 'Neue Anbieter brauchen mein Okay', 'Nouveaux fournisseurs requièrent mon accord', 'Nuevos proveedores requieren mi sí', 'I fornitori nuovi richiedono il mio ok', 'Novos fornecedores exigem meu sim', '新規ベンダーは承認必須', '新供应商需我批准'],
  'label.spendingWindow': ['Spending window', 'Zeitfenster', 'Fenêtre de dépense', 'Ventana de gasto', 'Finestra di spesa', 'Janela de gastos', '利用時間帯', '消费时间窗'],
  'label.windowStart': ['Spending window start', 'Beginn des Zeitfensters', 'Début de la fenêtre', 'Inicio de la ventana', 'Inizio della finestra', 'Início da janela', '時間帯の開始', '时间窗开始'],
  'label.windowEnd': ['Spending window end', 'Ende des Zeitfensters', 'Fin de la fenêtre', 'Fin de la ventana', 'Fine della finestra', 'Fim da janela', '時間帯の終了', '时间窗结束'],
  'label.currency': ['Currency', 'Währung', 'Devise', 'Divisa', 'Valuta', 'Moeda', '通貨', '货币'],
  'label.decisionNote': ['Decision note — recorded in the ledger', 'Entscheidungsnotiz — wird im Hauptbuch erfasst', 'Note de décision — consignée dans le registre', 'Nota de decisión — registrada en el libro mayor', 'Nota decisione — registrata nel registro', 'Nota de decisão — registrada no livro-razão', '決定ノート — 台帳に記録', '决定备注 — 记入账本'],
  'label.agentId': ['Agent id (a-z, 0-9, dash)', 'Agenten-ID (a-z, 0-9, Bindestrich)', "ID de l'agent (a-z, 0-9, tiret)", 'ID de agente (a-z, 0-9, guion)', 'ID agente (a-z, 0-9, trattino)', 'ID do agente (a-z, 0-9, hífen)', 'エージェントID（a-z、0-9、ハイフン）', '代理 ID（a-z、0-9、连字符）'],
  'label.displayName': ['Display name', 'Anzeigename', "Nom d'affichage", 'Nombre visible', 'Nome visualizzato', 'Nome de exibição', '表示名', '显示名称'],

  // table headers
  'th.vendor': ['Vendor', 'Anbieter', 'Fournisseur', 'Proveedor', 'Fornitore', 'Fornecedor', 'ベンダー', '供应商'],
  'th.action': ['Action', 'Aktion', 'Action', 'Acción', 'Azione', 'Ação', '操作', '操作'],
  'th.decision': ['Decision', 'Entscheidung', 'Décision', 'Decisión', 'Decisione', 'Decisão', '決定', '决定'],
  'th.time': ['Time', 'Zeit', 'Heure', 'Hora', 'Ora', 'Hora', '時刻', '时间'],
  'th.amount': ['Amount', 'Betrag', 'Montant', 'Importe', 'Importo', 'Valor', '金額', '金额'],
  'th.date': ['Date', 'Datum', 'Date', 'Fecha', 'Data', 'Data', '日付', '日期'],
  'th.agent': ['Agent', 'Agent', 'Agent', 'Agente', 'Agente', 'Agente', 'エージェント', '代理'],

  // empty states + hints
  'empty.approvals': ['No pending escalations. Policy is clearing everything without you.', 'Keine ausstehenden Eskalationen. Die Richtlinie erledigt alles ohne Sie.', 'Aucune escalade en attente. La politique gère tout sans vous.', 'Sin escalaciones pendientes. La política lo resuelve todo sin usted.', 'Nessuna escalation in attesa. Le policy gestiscono tutto senza di te.', 'Sem escaladas pendentes. A política resolve tudo sem você.', '保留中のエスカレーションはありません。ポリシーがすべてを処理します。', '没有待处理的升级事项。策略无需您介入即可处理一切。'],
  'empty.ledger': ['Ledger is empty.', 'Das Hauptbuch ist leer.', 'Le registre est vide.', 'El registro está vacío.', 'Il registro è vuoto.', 'O livro está vazio.', '台帳は空です。', '账本为空。'],
  'empty.overview': ['No transactions yet. Run', 'Noch keine Transaktionen. Ausführen:', 'Aucune transaction pour le moment. Exécutez', 'Aún no hay transacciones. Ejecute', 'Nessuna transazione. Esegui', 'Ainda sem transações. Execute', 'まだ取引がありません。実行:', '尚无交易。运行'],
  'hint.clickRow': ['Click a row for hashes and signatures', 'Zeile anklicken für Hashes und Signaturen', 'Cliquez sur une ligne pour les hachages et signatures', 'Haga clic en una fila para ver hashes y firmas', 'Fai clic su una riga per hash e firme', 'Clique numa linha para hashes e assinaturas', 'ハッシュと署名を表示するには行をクリック', '点击行查看哈希与签名'],
  'hint.registered': ['registered with a cautious default policy', 'mit vorsichtiger Standardrichtlinie registriert', 'inscrit avec une politique prudente par défaut', 'registrado con una política prudente por defecto', 'registrato con una policy prudente predefinita', 'registrado com uma política prudente padrão', '慎重なデフォルトポリシーで登録済み', '已注册，采用谨慎的默认策略'],
  'hint.registerDefault': ['new agents start with a cautious default policy', 'neue Agenten starten mit einer vorsichtigen Standardrichtlinie', 'les nouveaux agents démarrent avec une politique prudente', 'los agentes nuevos inician con una política prudente', 'i nuovi agenti partono con una policy prudente', 'novos agentes começam com uma política prudente', '新規エージェントは慎重なデフォルトポリシーで開始', '新代理采用谨慎的默认策略'],

  // ledger banner
  'banner.verified': ['Chain integrity verified', 'Integrität der Kette bestätigt', 'Intégrité de la chaîne vérifiée', 'Integridad de la cadena verificada', 'Integrità della catena verificata', 'Integridade da cadeia verificada', 'チェーンの整合性を確認', '链完整性已验证'],
  'banner.broken': ['Chain broken at entry #{n}', 'Kette unterbrochen bei Eintrag #{n}', 'Chaîne cassée à l’entrée #{n}', 'Cadena rota en la entrada #{n}', 'Catena interrotta alla voce #{n}', 'Cadeia quebrada na entrada #{n}', 'エントリ #{n} でチェーンが破損', '链在第 #{n} 条记录处断裂'],
  'banner.sub': ['SHA-256 hash-chained · HMAC-signed · tamper-evident', 'SHA-256 verkettet · HMAC-signiert · manipulationssicher', 'Chaînés SHA-256 · signés HMAC · inviolables', 'Encadenado SHA-256 · firmado HMAC · a prueba de manipulación', 'Concatenati SHA-256 · firmati HMAC · antimanomissione', 'Encadeado SHA-256 · assinado HMAC · à prova de adulteração', 'SHA-256 ハッシュ連鎖 · HMAC 署名 · 改ざん検知', 'SHA-256 哈希链 · HMAC 签名 · 防篡改'],

  // approvals recent
  'sec.recentDecisions': ['Recent decisions', 'Letzte Entscheidungen', 'Décisions récentes', 'Decisiones recientes', 'Decisioni recenti', 'Decisões recentes', '最近の決定', '最近决定'],
  'sec.lastN': ['Last {n}', 'Letzte {n}', 'Dernières {n}', 'Últimas {n}', 'Ultime {n}', 'Últimas {n}', '直近 {n} 件', '最近 {n} 条'],
  'sec.ledgerActivity': ['Ledger activity', 'Hauptbuchaktivität', 'Activité du registre', 'Actividad del libro', 'Attività del registro', 'Atividade do livro', '台帳のアクティビティ', '账本动态'],

  // modals (agents page)
  'modal.saveTitle': ['Save policy for {name}?', 'Richtlinie für {name} speichern?', 'Enregistrer la politique pour {name} ?', '¿Guardar política para {name}?', 'Salvare la policy per {name}?', 'Salvar política para {name}?', '{name} のポリシーを保存しますか？', '保存 {name} 的策略？'],
  'modal.saveBody': ['Applies to every next intent from {id}. Previous decisions stay in the ledger.', 'Gilt für jeden nächsten Auftrag von {id}. Frühere Entscheidungen bleiben im Hauptbuch.', "S'applique à chaque prochaine intention de {id}. Les décisions précédentes restent dans le registre.", 'Se aplica a cada próxima intención de {id}. Las decisiones anteriores permanecen en el libro mayor.', 'Si applica a ogni prossima intenzione di {id}. Le decisioni precedenti restano nel registro.', 'Aplica-se a cada próxima intenção de {id}. Decisões anteriores permanecem no livro.', '{id} からの次のインテントすべてに適用されます。以前の決定は台帳に残ります。', '适用于 {id} 的后续所有请求。此前的决定保留在账本中。'],
  'modal.saved': ['Saved — applies to the next intent', 'Gespeichert — gilt für den nächsten Auftrag', 'Enregistré — s’applique à la prochaine intention', 'Guardado — se aplica a la próxima intención', 'Salvato — si applica alla prossima intenzione', 'Salvo — aplica-se à próxima intenção', '保存しました — 次のインテントに適用', '已保存 — 适用于下一请求'],
  'modal.removeVendorTitle': ['Remove blocked vendor?', 'Blockierten Anbieter entfernen?', 'Supprimer le fournisseur bloqué ?', '¿Eliminar proveedor bloqueado?', 'Rimuovere il fornitore bloccato?', 'Remover fornecedor bloqueado?', 'ブロック済みベンダーを削除しますか？', '移除已屏蔽供应商？'],
  'modal.removeVendorBody': ['"{v}" will be unblocked for {id} once you save the policy.', '"{v}" wird für {id} freigegeben, sobald Sie die Richtlinie speichern.', '"{v}" sera débloqué pour {id} une fois la politique enregistrée.', '"{v}" se desbloqueará para {id} al guardar la política.', '"{v}" sarà sbloccato per {id} al salvataggio della policy.', '"{v}" será desbloqueado para {id} ao salvar a política.', 'ポリシーを保存すると {id} に対して「{v}」のブロックが解除されます。', '保存策略后，将解除 {id} 对 "{v}" 的屏蔽。'],
  'modal.removed': ['Removed — save policy to apply', 'Entfernt — Richtlinie speichern zum Übernehmen', 'Supprimé — enregistrez la politique pour appliquer', 'Eliminado — guarde la política para aplicar', 'Rimosso — salva la policy per applicare', 'Removido — salve a política para aplicar', '削除しました — 保存して適用', '已移除 — 保存策略后生效'],
  'modal.removeAgentTitle': ['Remove {name}?', '{name} entfernen?', 'Supprimer {name} ?', '¿Eliminar {name}?', 'Rimuovere {name}?', 'Remover {name}?', '{name} を削除しますか？', '删除 {name}？'],
  'modal.removeAgentBody': ['Their policy is deleted. Ledger history stays in the audit trail.', 'Ihre Richtlinie wird gelöscht. Der Verlauf bleibt im Prüfpfad.', 'Leur politique est supprimée. L’historique reste dans la piste d’audit.', 'Su política se elimina. El historial permanece en la pista de auditoría.', 'La sua policy viene eliminata. Lo storico resta nella traccia di audit.', 'A política deles é excluída. O histórico permanece na trilha de auditoria.', 'ポリシーは削除されます。履歴は監査証跡に残ります。', '其策略将被删除。历史记录保留在审计轨迹中。'],
  'modal.agentRemoved': ['Agent removed', 'Agent entfernt', 'Agent supprimé', 'Agente eliminado', 'Agente rimosso', 'Agente removido', 'エージェントを削除しました', '代理已删除'],
  'modal.registerTitle': ['Register agent', 'Agent registrieren', "Enregistrer l'agent", 'Registrar agente', 'Registra agente', 'Registrar agente', 'エージェントを登録', '注册代理'],
  'modal.saving': ['Saving…', 'Speichern…', 'Enregistrement…', 'Guardando…', 'Salvataggio…', 'Salvando…', '保存中…', '保存中…'],
  'modal.working': ['Working…', 'Verarbeitung…', 'Traitement…', 'Procesando…', 'Elaborazione…', 'Processando…', '処理中…', '处理中…'],

  // sidebar
  'side.live': ['Live', 'Live', 'En direct', 'En vivo', 'Diretto', 'Ao vivo', 'ライブ', '在线'],
  'side.offline': ['Offline', 'Offline', 'Hors ligne', 'Desconectado', 'Offline', 'Offline', 'オフライン', '离线'],
  'side.copyright': ['© 2026 Britannic & Balkan', '© 2026 Britannic & Balkan', '© 2026 Britannic & Balkan', '© 2026 Britannic & Balkan', '© 2026 Britannic & Balkan', '© 2026 Britannic & Balkan', '© 2026 Britannic & Balkan', '© 2026 Britannic & Balkan'],

  // overview stat cards
  'stat.allowed': ['Auto-allowed today', 'Heute automatisch erlaubt', 'Auto-autorisés aujourd’hui', 'Auto permitidos hoy', 'Auto-ammessi oggi', 'Auto-permitidos hoje', '今日の自動承認', '今日自动批准'],
  'stat.approved': ['Human-approved today', 'Heute manuell genehmigt', 'Approuvés manuellement aujourd’hui', 'Aprobados manualmente hoy', 'Approvati manualmente oggi', 'Aprovados manualmente hoje', '今日の手動承認', '今日人工批准'],
  'stat.denied': ['Denied today', 'Heute abgelehnt', 'Refusés aujourd’hui', 'Denegados hoy', 'Negati oggi', 'Negados hoje', '今日の拒否', '今日拒绝'],
  'stat.pending': ['Pending approval', 'Genehmigung ausstehend', 'En attente d’approbation', 'Aprobación pendiente', 'In attesa di approvazione', 'Aprovação pendente', '承認待ち', '待审批'],
};

const idx = (l: Lang) => LANGS.indexOf(l);

type LangCtx = { lang: Lang; setLang: (l: Lang) => void; t: (key: string, vars?: Record<string, string | number>) => string };

const Ctx = createContext<LangCtx>({
  lang: 'en',
  setLang: () => undefined,
  t: (key, vars) => {
    let s = D[key]?.[0] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  },
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem('sg-lang');
    return (LANGS as readonly string[]).includes(saved ?? '') ? (saved as Lang) : 'en';
  });

  const setLang = (l: Lang) => {
    setLangState(l);
    localStorage.setItem('sg-lang', l);
  };

  const t = (key: string, vars?: Record<string, string | number>) => {
    let s = D[key]?.[idx(lang)] ?? D[key]?.[0] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };

  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export const useLang = () => useContext(Ctx);
