# 🤖 Rep4Rep Bot CLI + Painel Web

Automação de comentários para Steam integrada ao [Rep4Rep.com](https://rep4rep.com) com modo terminal, painel administrativo e fluxo seguro para vender execuções a clientes sem expor suas contas.

## 📚 Índice rápido
1. [Visão geral](#-visão-geral)
2. [Requisitos](#-requisitos)
3. [Instalação e configuração](#-instalação-e-configuração)
4. [Fluxo de trabalho](#-fluxo-de-trabalho)
5. [Comandos da CLI](#-comandos-da-cli)
6. [Prioridade, limites e limpeza](#-prioridade-limites-e-limpeza)
7. [Painel web](#-painel-web)
   - [Acesso do administrador](#acesso-do-administrador)
   - [Portal do cliente](#portal-do-cliente)
   - [Créditos e permissões](#créditos-e-permissões)
8. [Armazenamento e segurança](#-armazenamento-e-segurança)
9. [Variáveis de ambiente](#-variáveis-de-ambiente)
10. [Scripts disponíveis](#-scripts-disponíveis)
11. [Dicas e suporte](#-dicas-e-suporte)

## 📌 Visão geral
- `main.cjs` oferece a CLI completa para administrar contas, rodar execuções prioritárias e disparar o ciclo completo de adicionar ➜ comentar ➜ remover perfis.
- `src/` contém o núcleo do bot (login Steam, cliente Rep4Rep, agendador prioritário e utilidades de banco).
- `web/` disponibiliza painel Express + EJS com autenticação básica para o administrador e portal de autoatendimento para clientes.
- O banco SQLite (`steamprofiles.db`) guarda perfis Steam, cookies, histórico de comentários e os usuários do painel.

```
📦 root
├── accounts.txt          # Lista de contas Steam (username:senha:shared_secret)
├── main.cjs              # Menu da CLI
├── src/                  # Bot, autoRun, integrações com Rep4Rep e banco
├── web/                  # Painel admin + portal do cliente (Express)
├── data/
│   ├── exports/          # Arquivos CSV gerados pela CLI
│   └── users.json        # Arquivo legacy somente para referência
├── logs/                 # Registros diários de execuções
├── backups/              # Backups criados pela CLI/painel
├── steamprofiles.db      # Banco SQLite principal
├── package.json          # Scripts principais do projeto
└── env.example           # Exemplo de configuração .env
```

## 🛠️ Requisitos
- Node.js v18 ou superior.
- Conta ativa no [Rep4Rep](https://rep4rep.com) com chave de API.
- Arquivo `accounts.txt` preenchido com as contas Steam que irão comentar.
- Variáveis de ambiente configuradas (veja [Variáveis de ambiente](#-variáveis-de-ambiente)).

## ⚙️ Instalação e configuração
1. Copie `env.example` para `.env` e ajuste credenciais, delays e limites desejados.
2. Instale dependências:
   ```bash
   npm install
   cd web && npm install
   ```
   > 💡 Usuários Windows podem executar `install-bot.bat` para automatizar a criação do `.env` e a instalação das dependências da raiz e do painel.
3. Preencha `accounts.txt` com uma conta por linha (`username:senha:shared_secret`).
4. (Opcional) Popule `data/users.json` apenas como semente. Na primeira execução os dados são migrados para o SQLite automaticamente.
5. Inicie apenas o bot (`npm run bot`), somente o painel (`npm run painel`) ou ambos (`npm run dev`). No Windows, o arquivo `start-bot.bat` oferece um menu para iniciar apenas a CLI ou CLI + painel (com ou sem abrir o navegador).

## 🔄 Fluxo de trabalho
- **Uso próprio via terminal:** a CLI utiliza sempre a `REP4REP_KEY` do `.env`, garantindo prioridade às suas tarefas e funcionamento mesmo que não exista painel.
- **Vendas e clientes:** o painel registra usuários com créditos, chave Rep4Rep própria e cuida do débito automático a cada comentário concluído.
- **Agendador prioritário:** toda execução dispara primeiro o lote do proprietário (token do `.env` ou da conta admin) e, somente se não houver comentários pendentes, percorre clientes elegíveis.
- **Fila inteligente:** pedidos disparados pelo painel ou pela API entram em uma fila FIFO com posição e estimativa de início; apenas um cliente é atendido por vez após a rodada do proprietário.

## 🖥️ Comandos da CLI
| Nº  | Ação                                                            |
|-----|-----------------------------------------------------------------|
| 1   | Mostrar perfis cadastrados                                      |
| 2   | Autorizar todos perfis (atualiza cookies)                       |
| 3   | **Executar autoRun prioritário** (proprietário ➜ clientes)      |
| 4   | Adicionar perfis do arquivo `accounts.txt`                      |
| 5   | Adicionar perfis e rodar imediatamente                          |
| 6   | Remover perfil                                                  |
| 7   | Verificar e sincronizar perfis com Rep4Rep                      |
| 8   | Verificar disponibilidade de comentários                        |
| 9   | Verificar status/login das contas                               |
| 10  | Exportar perfis para CSV                                        |
| 11  | Limpar contas inválidas ou duplicadas em `accounts.txt`         |
| 12  | Estatísticas de uso dos perfis                                  |
| 13  | Resetar cookies                                                 |
| 14  | Criar backup do banco                                           |
| 15  | **Ciclo completo**: adiciona contas ➜ executa autoRun ➜ remove  |
| 16  | Ativar modo vigia (loop automático em segundo plano)             |
| 0   | Sair                                                            |

A opção 15 impõe automaticamente **100 contas** e **1000 comentários por conta** como teto, garantindo que execuções pontuais não ultrapassem o combinado com clientes.

## 🛡️ Prioridade, limites e limpeza
- Todas as execuções usam `MAX_COMMENTS_PER_RUN` saneado para 1000 comentários por conta no máximo.
- O agendador corta a lista de contas para, no máximo, 100 perfis por lote ao atender clientes.
- Clientes precisam ter perfis ativos no Rep4Rep antes da execução; o backend valida isso antes de iniciar.
- Ao rodar tarefas para clientes (via painel ou API), os perfis usados são removidos automaticamente do Rep4Rep ao final para não expor suas contas proprietárias.
- Cada usuário só pode ter um pedido ativo; a fila exibe posição, pedidos à frente e estimativa de início tanto no painel quanto no portal do cliente.
- Um serviço interno cria um **backup automático** do banco a cada 3 dias (ou quando nenhum backup recente é encontrado). Admins ainda podem gerar backups manuais sempre que desejarem.
- O modo vigia pode ser acionado pela CLI (opção 16) ou pelo painel admin para manter o bot em execução contínua no servidor respeitando o limite de 100 contas / 1000 comentários.

## 🌐 Painel web
O servidor Express roda em `http://localhost:3000` (ajustável via `PORT`). A rota raiz serve o portal do cliente; `/admin` abre o painel protegido por autenticação básica.

### Acesso do administrador
1. Configure `PANEL_USERNAME` e `PANEL_PASSWORD` no `.env`.
2. Cadastre um usuário com `role = admin` pelo painel e defina nele a chave Rep4Rep que deseja usar quando estiver logado no painel.
3. Ao clicar em **Executar autoRun** o painel busca essa chave no banco, executa o lote prioritário e segue com a fila de clientes. A chave do `.env` permanece oculta para o navegador.
4. O painel ainda traz estatísticas, criação de backups e histórico de logs em tempo real.
5. O card **Modo VPS / Vigia** permite iniciar/parar o loop automático diretamente do painel e acompanha status, intervalo configurado e erros do ciclo.
6. O card **Fila de execuções** mostra pedidos pendentes, histórico recente e permite atualizar a fila manualmente.
7. Clique em **Gerenciar** na tabela de clientes para abrir o editor lateral e ajustar dados completos (status, créditos, key, telefone, role) sem editar código.

### Portal do cliente
- Cadastro exige nome completo, username, email, senha (≥ 8 caracteres), data de nascimento, Discord ID, Rep4Rep ID e telefone/WhatsApp com DDI.
- Após o registro o status fica `pending`. O administrador precisa ativar e conceder créditos antes de liberar o botão **Rodar tarefas**.
- Clientes autenticados visualizam créditos, status, token de API e podem atualizar a própria chave Rep4Rep.
- Ao solicitar execução o pedido entra na fila; o painel mostra posição/estimativa em tempo real e o portal do cliente exibe o mesmo resumo com botão de atualizar status.

### Créditos e permissões
- **1 crédito = 1 comentário confirmado.** Durante o autoRun, cada comentário chama o callback de débito.
- Usuários `admin` têm créditos ilimitados mas ainda precisam cadastrar a própria chave Rep4Rep.
- Quando os créditos chegam a zero a API retorna `HTTP 402` até que o administrador adicione mais saldo.
- O administrador pode ajustar créditos, status e dados de qualquer usuário pelo painel ou via endpoints autenticados em `/admin/api`.

### Tradução automática do painel
- O cabeçalho do painel inclui o botão 🌐 **Idioma** com um seletor discreto alimentado pelo Google Translate.
- Estão disponíveis traduções instantâneas para português, inglês, espanhol, francês, italiano e alemão sem recarregar a página.
- A interface do widget segue o tema escuro do painel e pode ser recolhida para não interferir no fluxo de trabalho.

## 🔐 Armazenamento e segurança
- Usuários e perfis ficam no SQLite (`steamprofiles.db`). Senhas são protegidas com PBKDF2 (sal + hash) e tokens API são UUIDs aleatórios.
- O arquivo `data/users.json` é mantido apenas como **backup legado**: as senhas não aparecem ali por segurança. Após a migração todos os campos sensíveis permanecem somente no banco criptografado.
- Logs de execução são gravados em `logs/YYYY-MM-DD.log` e podem ser revisados pelo painel.

## 🌱 Variáveis de ambiente
| Variável | Descrição |
|----------|-----------|
| `REP4REP_KEY` | Chave Rep4Rep usada pela CLI e como fallback do proprietário. |
| `MAX_COMMENTS_PER_RUN` | Limite por conta (cortado automaticamente em 1000). |
| `LOGIN_DELAY` / `COMMENT_DELAY` | Delays (ms) entre logins e comentários. |
| `PANEL_USERNAME` / `PANEL_PASSWORD` | Credenciais do Basic Auth do painel. |
| `PORT` | Porta HTTP do painel (padrão `3000`). |
| `DATABASE_PATH` | Caminho alternativo para o `steamprofiles.db` (opcional). |
| `KEEPALIVE_INTERVAL_MINUTES` | Intervalo (min) entre ciclos do modo vigia automático (mínimo 5). |

Outras variáveis herdadas do `env.example` continuam válidas (SMTP, Discord, etc.).

## 🧰 Scripts disponíveis
```bash
npm run bot     # Inicia apenas a CLI
npm run painel  # Inicia apenas o painel web (web/server.js)
npm run dev     # Executa CLI + painel simultaneamente
install-bot.bat # (Windows) prepara .env e instala dependências
start-bot.bat   # (Windows) inicia CLI e/ou painel com menu interativo
```

## 💡 Dicas e suporte
- Execute periodicamente a opção 14 (backup) antes de atualizar o projeto.
- Utilize a opção 11 para manter `accounts.txt` limpo e evitar contas duplicadas.
- Para vender execuções automáticas exponha apenas a API `/api/user` e mantenha o painel protegido por VPN/Basic Auth.
- Dúvidas adicionais? Consulte os logs (`npm run painel` ➜ `/admin/logs`) ou edite `src/util.cjs` para habilitar mais mensagens.

