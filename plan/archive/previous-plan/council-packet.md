# Council packet

Profile: full; topology: single-host; thesis T-001

## Objective

Entregar um plano implementável para RemoteCode na nuvem, com Files, Git, Terminal, Agent App, Bots, navegador, tarefas agendadas e notificações confiáveis em web e iOS.

## Scope

Uma conta acessa o mesmo workspace persistente pela web e pelo iOS, com isolamento entre usuários.

Files, Git, Terminal, Agent App, Bots e preview do navegador funcionam no workspace Linux com estado restaurável.

Tarefas agendadas de Agent App e Bots executam sem cliente conectado, criam execução/conversa correta e admitem inspeção e parada.

Cada evento relevante tem registro durável, entrega em tempo real e política de push para web e iOS com preferências, deduplicação e rota correta.

Migração, segurança, custos, operação, fases e provas de aceitação estão definidos antes do lançamento.

## Invariants

A VPS é fonte de verdade do workspace; o cliente não inventa sucesso ou estado de execução.

Estado explícito do usuário sobrevive fechar/reabrir clientes e reiniciar o runtime.

Eventos canônicos sustentam web/iOS; push é derivado do registro durável, nunca fonte única.

Token Saver desligado não executa otimizações; métricas e estimativas preservam contrato existente quando portadas.

Uma ocorrência agendada cria conversa nova e não reaproveita thread selecionada.

## Thesis

Conta e gateway selecionam uma VPS isolada; agente do workspace persiste estado/execução; web e iOS consomem snapshot + eventos com sequência. Scheduler na nuvem faz claim durável e lança runs no mesmo runtime. Cada evento relevante grava feed/outbox; dispatcher entrega APNs/Web Push conforme preferências, sem incluir dados sensíveis. Piloto sempre ligado mede limites antes da expansão.

## Alternatives

Uma única VPS compartilhada com usuários do sistema: menor custo bruto, mas fronteira de isolamento e blast radius mais difíceis no piloto.

Converter o Mac em servidor remoto: não atende ao requisito de independência do Mac.

Enviar push diretamente de cada processo: duplica notificações, perde eventos em falhas e mistura autorização com execução.

## Steps

S-001 Fundação da conta e VPS: Implementar mapeamento conta→workspace→VPS no backend privado com autenticação de sessão e autorização por objeto.; Provisionar VPS Linux por usuário com imagem versionada, 2 vCPU/4 GB piloto, disco persistente cifrado, rede privada, backup e quotas.; Expor gateway TLS autenticado para RPC/eventos/preview; cada chamada e stream validam conta e destino.

S-002 Estado, arquivos, Git e terminal: Separar execução/estado de AppKit e apontar o serviço de workspace Linux ao mesmo contrato de arquivo, Git e eventos.; Persistir seleção, panes, tabs, URLs/títulos, sessões de terminal e metadados; anexar ao reconectar com snapshot + sequência.; Expor preview privado de localhost da VPS por URL autorizada; proteger caminhos, symlinks, comandos e portas.

S-003 Agent App e Bots no Linux: Adaptar runners Claude/Codex/Grok e Bot runtime para Linux mantendo provider/modelo/permissão e falha explícita para recurso não suportado.; Persistir threads, mensagens, runs, anexos, atenção, bot memory/rotinas e fila; proibir segredo em logs/streams.; Reconectar clientes ao run ativo, parar com autoridade do servidor e preservar original quando Token Saver falhar ou estiver desligado.

S-004 Tarefas agendadas na nuvem: Portar recorrência/fuso/claim/heartbeat de ScheduledTaskStore para autoridade sempre ativa da VPS; substituir ServiceManagement/XPC por worker de nuvem.; Oferecer criar/editar/pausar/executar agora/parar, histórico, próxima ocorrência e política explícita para downtime; cada ocorrência usa chave idempotente.; Executar tarefas de Agent App e rotinas de Bot em conversa nova, associando run, bot, workspace e origem; reconciliar crash sem repetir efeito incerto.

S-005 Notificações e push multicanal: Definir catálogo canônico de eventos e gravar feed + outbox atomicamente após efeito de negócio; id estável, conta, workspace, objeto, categoria, prioridade e rota.; Registrar dispositivos APNs e assinaturas Web Push por conta, validar propriedade, expirar/revogar tokens e aplicar preferências no servidor, horário silencioso, dedupe e rate limit.; Entregar stream ao vivo para interface aberta; APNs ao app iOS e Web Push a navegadores compatíveis; tap abre objeto exato; fallback é inbox durável.

S-006 Migração e coexistência: Inventariar estado macOS/iOS, mapear IDs e exportar dados em formato versionado com checksum; segredos exigem reautorização quando não exportáveis.; Fazer importação ensaiada em workspace novo, comparar contagens e conteúdos, validar deep links e retomar por checkpoint; sem dual-write indefinido.; Habilitar por conta, manter cliente atual durante beta, mostrar origem dos dados e oferecer retorno ao estado anterior até aceite.

S-007 QA, custos e lançamento: Testar jornadas completas web desktop, Safari iPhone/PWA e app iOS; rede ruim, reconexão, refresh, duas abas, troca de conta e tentativa de acesso cruzado.; Medir pelo menos cinco amostras aquecidas de fluxos de carregamento, CPU/RAM/IO, custo por usuário e volume de push; definir limites e upgrade de 4 GB.; Lançar em ondas internas→beta→geral com métricas, alertas, backup/restore, rollback por conta e gates de suporte.

## Evidence

E-001 ScheduledTaskExecutor cria thread durável e envia run headless pelo router do macOS. [Sources/AppShell/ScheduledTaskRuntime.swift:106]

E-002 ScheduledTask inclui recorrência, fuso IANA, workspace, provider e identidade de usuário do sistema. [Sources/CoreModel/ScheduledTask.swift:19]

E-003 ScheduledTaskStore implementa claim de ocorrência, run, heartbeat e recuperação de leases. [Sources/Persistence/ScheduledTaskStore.swift:211]

E-004 O scheduler atual ignora ocorrências perdidas ao abrir o aplicativo e descreve execução vinculada ao app. [Sources/AppShell/ScheduledTaskRuntime.swift:736]

E-005 NotificationRepository mantém feed persistente com marcação de lido e descarte. [Sources/Persistence/Notifications.swift:20]

E-006 SystemNotifier publica alertas locais via UNUserNotificationCenter em bundle macOS. [Sources/AppShell/SystemNotifier.swift:51]

E-007 WorkspaceFileService já oferece listagem, leitura, edição e operações de arquivo para acesso remoto. [Sources/SocketServer/WorkspaceFileService.swift:32]

E-008 BotStore persiste bots, conversas, atenção e rotinas. [Sources/Persistence/BotStore.swift:44]

E-009 O runtime atual de agendamento contém ServiceManagement, NSXPC e seleção de usuário macOS. [Sources/AppShell/ScheduledTaskRuntime.swift:5]

E-010 Os clientes iOS distinguem WebSocket de eventos em tempo real e RPC por HTTP. [command: sed -n 1,100p ios-app/App/Sources/ConnectionKit/LivePushTransportPolicy.swift]

E-011 O app iOS registra APNs e tem preferências de categoria e horário silencioso no cliente. [command: sed -n 1,150p ios-app/App/Sources/Notifications/PushNotificationRegistration.swift]

E-012 O backend privado inclui serviço para envio de alertas APNs. [command: rg -n deliverAlert private/backend/src/modules/push-notification/push-notification.service.ts]

E-013 Apple suporta Web Push no iOS em web apps adicionadas à Tela de Início desde iOS 16.4. [https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers]

E-014 A arquitetura documenta SQLite local, EventBus, WebSocket e sessão persistida. [docs/architecture.md:40]

E-015 O usuário escolheu workspace na nuvem e propôs VPS de 4 GB por usuário. [user decision: conversa atual sobre workspace em nuvem e VPS de 4 GB]

E-016 GitHub Codespaces usa ambientes Linux no navegador, com máquinas iniciando em 2 núcleos e 8 GB. [https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces]

## Assumptions and unknowns

A-001 Cada conta terá inicialmente uma VPS sempre ligada e um workspace principal; 4 GB é hipótese de piloto, com upgrade se os testes falharem.

A-002 “Push de tudo” significa catalogar todos os eventos relevantes no feed e permitir push por categoria/prioridade, não emitir um alerta por byte ou delta.

U-001 Compatibilidade e desempenho dos executores Claude, Codex, Grok e Token Saver em Linux 4 GB, inclusive runs simultâneos.

U-002 Local de residência e volume dos dados existentes que terão migração para a nuvem.

U-003 Orçamento por usuário, concorrência e volume de push para definir preço e limites de uso.

## Risks

R-001 Uma falha de autorização expõe arquivos, terminal ou segredos de outra conta.; mitigation: Testes de isolamento em todas as APIs, token curto, rede privada, auditoria e revisão externa antes do beta.

R-002 4 GB podem provocar OOM em build, browser e agentes simultâneos.; mitigation: Medir workload representativo; impor limites por processo e elevar plano base a 8 GB se falhar.

R-003 Push por evento bruto gera spam e exposição de conteúdo sensível.; mitigation: Inbox completa; push só em transições definidas, títulos seguros, preferências e compactação por thread.

R-004 Falha de scheduler ou rede duplica uma ação externa do bot.; mitigation: Chave de ocorrência e recibo durável; resultado incerto exige reconciliação antes de retry.

R-005 Dados locais ou integrações exclusivas de macOS não migram integralmente.; mitigation: Inventário por recurso, ensaio com checksum, reautorização e indicação clara de recursos incompatíveis.

## Seat mission

Try to falsify this system-development thesis within your assigned lens only. Find at most three concrete, load-bearing failure mechanisms, most severe and best supported first; prefer one causal mechanism over stylistic remarks. Use the supplied evidence; separate fact, inference, assumption, and missing evidence; name the proof that would settle each uncertainty and the smallest sufficient correction. Never approve by deference or vote. Return NO_MATERIAL_OBJECTION when that is honest. Stay under 1,000 words and stop at the cap. Return the response only as your final result; write no files. Response fields: reviewer_id, provider, thesis_id, search_summary, verdict (OBJECTIONS|NO_MATERIAL_OBJECTION|BLOCKED), objections (0-3, each claim, failure_mode, severity (BLOCKER|HIGH|MEDIUM|LOW|UNSUPPORTED), confidence (0-100), premise_ids, evidence_ids, required_proof, smallest_correction), disconfirming_evidence, residual_uncertainty.
