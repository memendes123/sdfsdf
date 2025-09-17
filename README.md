# 🤖 Rep4Rep Bot CLI + Painel Web

Automação de comentários no Steam via [Rep4Rep.com](https://rep4rep.com) com suporte a múltiplas contas, controle de créditos por cliente e painel web para administração e uso seguro por terceiros.

---

## 📚 Índice rápido

1. [Requisitos](#-requisitos)
2. [Instalação e configuração](#-instalação-e-configuração)
3. [Estrutura do projeto](#-estrutura-do-projeto)
4. [Comandos da CLI](#-comandos-da-clicjs)
5. [Como funciona o painel web](#-como-funciona-o-painel-web)
   - [Acesso do administrador](#acesso-do-administrador)
   - [Portal do cliente e fluxo de login](#portal-do-cliente-e-fluxo-de-login)
   - [Gerenciamento de clientes e créditos](#gerenciamento-de-clientes-e-créditos)
   - [Fluxo de créditos e permissões](#fluxo-de-créditos-e-permissões)
   - [API pública para clientes](#api-pública-para-clientes)
6. [Banco de dados e armazenamento](#-banco-de-dados-e-armazenamento)
7. [Variáveis de ambiente](#-variáveis-de-ambiente)
8. [Scripts disponíveis](#-scripts-disponíveis)
9. [Hospedagem e domínio personalizado](#-hospedagem-e-domínio-personalizado)
10. [Suporte](#-suporte)
   - [Gerenciamento de clientes e créditos](#gerenciamento-de-clientes-e-créditos)
   - [Fluxo de créditos e permissões](#fluxo-de-créditos-e-permissões)
   - [API pública para clientes](#api-pública-para-clientes)
6. [Variáveis de ambiente](#-variáveis-de-ambiente)
7. [Scripts disponíveis](#-scripts-disponíveis)
8. [Suporte](#-suporte)

---

## 🛠️ Requisitos

- Node.js v18 ou superior
- Conta ativa no [rep4rep.com](https://rep4rep.com)
- Arquivo `.env` configurado (veja [Variáveis de ambiente](#-variáveis-de-ambiente))
- Arquivo `accounts.txt` com cada conta Steam no formato `username:password:shared_secret`

---

## ⚙️ Instalação e configuração

1. Copie `env.example` para `.env` e ajuste as credenciais.
2. Instale as dependências do bot e do painel:
   ```bash
   npm install
   cd web && npm install
   ```
3. Preencha `accounts.txt` com as contas que farão comentários.
4. Na primeira execução o painel cria a tabela `app_user` dentro de `steamprofiles.db`. Se você possui um `data/users.json` antigo ele será migrado automaticamente, mas novos clientes devem ser cadastrados pelo painel (`/admin`) ou via API.

Inicie apenas o bot com `npm run bot`, o painel com `npm run painel` ou tudo junto via `npm run dev`.

---


---

## ⚙️ Instalação e configuração

1. Copie `env.example` para `.env` e ajuste as credenciais.
2. Instale as dependências do bot e do painel:
   ```bash
   npm install
   cd web && npm install
   ```
3. Preencha `accounts.txt` com as contas que farão comentários.
4. Opcional: ajuste `data/users.json` para começar com seus próprios clientes.

Inicie apenas o bot com `npm run bot`, o painel com `npm run painel` ou tudo junto via `npm run dev`.

---

## 📁 Estrutura do projeto

```
📦 root
├── main.cjs               # Interface CLI
├── src/
│   ├── util.cjs           # Funções principais do bot e autoRun
│   ├── api.cjs            # Cliente Rep4Rep com suporte a múltiplas keys
│   ├── steamBot.cjs       # Login/Postagem de comentários
│   └── db.cjs             # Banco SQLite com perfis e status
├── web/                   # Painel administrativo (Express + EJS + JS/CSS)
├── data/                  # Exportações, backups e arquivos auxiliares
├── accounts.txt           # Contas Steam usadas nas automações
├── .env                   # Configurações sensíveis
├── steamprofiles.db       # Banco SQLite com perfis Steam e usuários do painel
├── data/users.json        # Base de clientes, créditos e tokens de API
├── accounts.txt           # Contas Steam usadas nas automações
├── .env                   # Configurações sensíveis
├── steamprofiles.db       # Banco local dos perfis sincronizados
└── logs/                  # Logs das execuções
```

---

## 🚀 Comandos da `main.cjs`

| Nº  | Ação                                              |
|----|----------------------------------------------------|
| 1  | Mostrar perfis cadastrados                         |
| 2  | Autorizar todos perfis (e sincronizar com Rep4Rep) |
| 3  | Executar comentários automáticos (autoRun)         |
| 4  | Adicionar perfis do arquivo `accounts.txt`         |
| 5  | Adicionar perfis e rodar imediatamente             |
| 6  | Remover perfil (precisa digitar username)          |
| 7  | Verificar e sincronizar perfis                     |
| 8  | Verificar disponibilidade de comentários           |
| 9  | Verificar se cada perfil ainda está logado         |
| 10 | Exportar perfis para CSV                           |
| 11 | Limpar contas inválidas (baseado no log diário)    |
| 12 | Estatísticas de uso dos perfis                     |
| 13 | Resetar cookies dos perfis                         |
| 14 | Criar backup do banco de dados                     |
| 0  | Sair                                               |

---

## 🌐 Como funciona o painel web

O painel fica em `web/server.js` e roda em `http://localhost:3000` (porta configurável via `PORT`). A raiz do site entrega o portal do cliente, enquanto o painel administrativo protegido por autenticação básica fica em `http://localhost:3000/admin`.
O painel fica em `web/server.js` e roda em `http://localhost:3000` (porta configurável via `PORT`). Ele foi desenhado para que apenas o administrador tenha controles avançados, enquanto os clientes consomem créditos por meio de uma API segura.

### Acesso do administrador

1. Garanta que `PANEL_USERNAME` e `PANEL_PASSWORD` estejam definidos no `.env`.
2. Inicie o painel com `npm run painel` (ou `npm run dev` para rodar bot + painel juntos).
3. Abra o navegador em `http://localhost:3000/admin` e faça login via autenticação básica.
3. Abra o navegador em `http://localhost:3000` e faça login via autenticação básica.
4. A área inicial oferece:
   - botões para `autoRun`, geração de estatísticas e backup do banco;
   - atualização ao vivo do resumo de contas (total, prontas, em cooldown, comentários nas últimas 24h);
   - visualização dos logs em `/logs`.

### Portal do cliente e fluxo de login

- O endereço público `http://localhost:3000/` expõe um portal onde o cliente pode **se registrar** ou **entrar** com o email/username.
- O formulário de cadastro exige: nome completo, username, email, senha (mínimo 8 caracteres), data de nascimento, Discord ID, Rep4Rep ID e telefone/WhatsApp com DDI. Email e Rep4Rep ID não podem ser duplicados.
- Assim que o cadastro é enviado o status fica como `pending`. O administrador precisa ativar a conta (via painel) e adicionar créditos antes que o cliente possa rodar tarefas.
- Após o login, o cliente visualiza créditos restantes, status da conta, seus identificadores e pode atualizar a própria chave Rep4Rep. O botão “Rodar tarefas” só é liberado quando a conta está ativa, existe uma key salva e o saldo é maior que zero.

### Gerenciamento de clientes e créditos

O cartão **Clientes e créditos** é exclusivo do administrador e permite:

- cadastrar um novo cliente com todos os campos obrigatórios (nome completo, username, email, senha provisória ≥8 caracteres, data de nascimento, Discord ID, Rep4Rep ID e telefone/WhatsApp), além da chave Rep4Rep opcional e créditos iniciais;
- armazenar tudo na tabela `app_user` do `steamprofiles.db`, com senha protegida via PBKDF2 e `apiToken` gerado automaticamente;
- ajustar créditos rapidamente com botões `-1`, `+1` e `+10`;
- visualizar status (ativo/bloqueado/pendente), identificadores do cliente e se a chave Rep4Rep já foi definida.

Para compartilhar o `apiToken` com o cliente, basta pedir que ele faça login pelo portal ou consultar `GET /admin/api/users` autenticado no painel (`curl -u usuario:senha http://localhost:3000/admin/api/users`).

Somente o administrador pode criar, editar ou adicionar créditos – os clientes não conseguem alterar seu saldo.

### Fluxo de créditos e permissões

- **1 crédito = 1 tarefa concluída (1 comentário)**. Durante o `autoRun`, cada comentário debitado chama o callback de consumo.
- Quando os créditos chegam a `0`, o cliente perde acesso aos comandos pagos e recebe `HTTP 402` até que o administrador adicione mais créditos.
 - O administrador pode pausar um cliente marcando o status como `blocked` pelo endpoint `PATCH /admin/api/users/:id` ou editando diretamente a tabela `app_user`.
- A chave Rep4Rep usada pelo cliente pode ser diferente da chave do administrador. O painel e a CLI continuam usando a key global definida no `.env`.
- O bot via terminal (`npm run bot`) segue operando normalmente com a sua `REP4REP_KEY` e não consome os créditos dos clientes — ideal para o administrador continuar as tarefas internas.

### API pública para clientes

Os clientes usam apenas a rota `/api/user`, autenticando-se com o `id` e o `token` obtidos após o login. Exemplo de fluxo completo usando `curl` e `jq`:

```bash
# registrar (status ficará pending até o administrador liberar créditos)
curl -X POST http://localhost:3000/api/user/register \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "João Cliente",
    "username": "joaocliente",
    "email": "joao@exemplo.com",
    "password": "senhaSegura123",
    "dateOfBirth": "1998-05-10",
    "discordId": "joao#1234",
    "rep4repId": "joao-rep",
    "phoneNumber": "+351900000000"
  }'

# login para obter token e id
login=$(curl -s -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"joao@exemplo.com","password":"senhaSegura123"}')
token=$(echo "$login" | jq -r '.token')
user_id=$(echo "$login" | jq -r '.user.id')

# consultar perfil autenticado
curl -X GET http://localhost:3000/api/user/me \
  -H "x-user-id: $user_id" \
  -H "Authorization: Bearer $token"
- cadastrar um novo cliente com nome, email, chave Rep4Rep e créditos iniciais;
- ajustar créditos rapidamente com botões `-1`, `+1` e `+10`;
- visualizar status (ativo/bloqueado/pendente) e se a chave Rep4Rep já foi definida.

Cada cliente recebe automaticamente um `apiToken`. Para compartilhá-lo com o usuário final você pode:

- abrir `data/users.json` e copiar os campos `id` e `apiToken`; ou
- chamar `GET /api/admin/users` autenticado no painel (ex.: via `curl -u admin:senha http://localhost:3000/api/admin/users`).

Somente o administrador pode criar, editar ou adicionar créditos – os clientes não conseguem alterar seu saldo.

### Fluxo de créditos e permissões

- **1 crédito = 1 tarefa concluída (1 comentário)**. Durante o `autoRun`, cada comentário debitado chama o callback de consumo.
- Quando os créditos chegam a `0`, o cliente perde acesso aos comandos pagos e recebe `HTTP 402` até que o administrador adicione mais créditos.
- O administrador pode pausar um cliente marcando o status como `blocked` (via edição direta no `data/users.json` ou endpoint futuro).
- A chave Rep4Rep usada pelo cliente pode ser diferente da chave do administrador. O painel e a CLI continuam usando a key global definida no `.env`.

### API pública para clientes

Os clientes usam apenas a rota `/api/user`, autenticando-se com cabeçalhos ou parâmetros. Exemplo com `curl`:

```bash
curl -X GET http://localhost:3000/api/user/me \
  -H "x-user-id: <ID_FORNECIDO>" \
  -H "x-user-token: <API_TOKEN>"
```

Endpoints disponíveis:

- `POST /api/user/register` — cria o cadastro com status `pending` e retorna `id` + `status`.
- `POST /api/user/login` — valida as credenciais e devolve `token` + dados do usuário.
- `GET /api/user/me` — retorna dados básicos, status e créditos restantes.
- `PATCH /api/user/me` — atualiza a chave Rep4Rep (`{ "rep4repKey": "..." }`).
- `GET /api/user/me` — retorna dados básicos, status e créditos restantes.
- `POST /api/user/run` — executa comandos seguros. Corpo esperado:

  ```json
  { "command": "autoRun" }
  ```

  Comandos suportados: `autoRun` (consome créditos) e `stats` (somente leitura).
  Comando suportados: `autoRun` (consome créditos) e `stats` (somente leitura).

Regras importantes:

- Antes de rodar `autoRun`, o cliente precisa informar a própria `rep4repKey` via painel/admin.
- O bot utiliza a key do cliente durante a execução; quando o limite de créditos é alcançado o processo é interrompido automaticamente.
- Se os créditos acabarem no meio do processo, o retorno será `HTTP 402` e nenhuma tarefa adicional será iniciada.

---

## 🗃️ Banco de dados e armazenamento

- Toda a persistência fica em `steamprofiles.db` (SQLite). Além das tabelas de perfis (`steamprofile`) e comentários (`comments`), agora existe a tabela `app_user` com os campos: `id`, `username`, `fullName`, `email`, `passwordHash`, `passwordSalt`, `dateOfBirth`, `discordId`, `rep4repId`, `phoneNumber`, `rep4repKey`, `credits`, `apiToken`, `role`, `status`, `lastLoginAt`, `createdAt` e `updatedAt`.
- Senhas são armazenadas com PBKDF2 (`sha512`, 120k iterações) e cada usuário recebe um `apiToken` aleatório. Para inspecionar rapidamente use `sqlite3 steamprofiles.db 'SELECT username, credits, status FROM app_user;'`.
- Caso exista um `data/users.json` legado, ele é importado automaticamente na primeira execução e renomeado para `users.json.bak`. Novos dados permanecem apenas no banco SQLite.
- Backups criados via painel são salvos em `backups/` e exportações CSV dos perfis ficam em `data/exports/`.

---

## ⚙️ Variáveis de ambiente

```env
# Token da API do Rep4Rep usado pelo administrador/CLI
REP4REP_KEY=seu_token_api

# Tempo entre logins e comentários (em ms)
LOGIN_DELAY=30000
COMMENT_DELAY=15000

# Comentários máximos por perfil em cada autoRun
MAX_COMMENTS_PER_RUN=10

# Credenciais de acesso ao painel web
PANEL_USERNAME=admin
PANEL_PASSWORD=senha123

# Porta opcional para o painel (padrão 3000)
PORT=3000
```

---

## 📦 Scripts disponíveis

| Comando        | Descrição                                 |
|----------------|-------------------------------------------|
| `npm run bot`     | Inicia apenas o bot (CLI)                 |
| `npm run painel`  | Sobe somente o painel web                 |
| `npm run dev`     | Roda painel e bot em paralelo             |
| `npm start`       | Abre navegador, bot e painel de uma vez   |

> **Dica:** mantenha `steamprofiles.db` e os arquivos em `backups/` fora do versionamento público, pois contêm senhas hash e tokens de acesso.

---

## 🌍 Hospedagem e domínio personalizado

1. **Servidor dedicado ou VPS** – Suba uma máquina Linux (Ubuntu/Debian) e instale Node.js 18+. Copie o projeto e configure o `.env`.
2. **Process manager** – Use `pm2` ou `systemd` para manter os processos sempre ativos:
   ```bash
   pm2 start "npm run bot" --name rep4rep-bot
   pm2 start "npm run painel" --name rep4rep-painel
   pm2 save
   ```
3. **DNS no GoDaddy/Namecheap** – Crie um registro `A` apontando o domínio para o IP do servidor. Após a propagação, configure um proxy (ex.: Nginx) redirecionando para `localhost:3000`:
   ```nginx
   server {
     server_name painel.seudominio.com;
     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```
4. **HTTPS automático** – Execute `certbot --nginx -d painel.seudominio.com` (ou use Caddy) para gerar certificados TLS gratuitos.
5. **Segurança extra** – Configure firewall liberando apenas portas 80/443, mantenha `PANEL_USERNAME`/`PANEL_PASSWORD` fortes e realize backups periódicos com o botão do painel ou via `sqlite3`.

> Dica: você pode mapear o portal do cliente em `painel.seudominio.com` e proteger a rota `/admin` com Basic Auth e IP restrito no Nginx para aumentar a segurança.

| Comando        | Descrição                                 |
|----------------|-------------------------------------------|
| `npm run bot`     | Inicia apenas o bot (CLI)                 |
| `npm run painel`  | Sobe somente o painel web                 |
| `npm run dev`     | Roda painel e bot em paralelo             |
| `npm start`       | Abre navegador, bot e painel de uma vez   |

> **Dica:** mantenha `data/users.json` fora do versionamento público ao lidar com dados reais (contém tokens e emails).

---

## 🆘 Suporte

Se algo não funcionar:

- confira as variáveis no `.env`;
- valide o formato do `accounts.txt`;
- consulte os logs mais recentes em `logs/` ou pelo painel (`/logs`).

---

## ✨ Ideias futuras

- Integração com Telegram para alertas em tempo real
- Portal completo para o cliente acompanhar pedidos
- Exportação detalhada de histórico de comentários
