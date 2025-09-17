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

O painel fica em `web/server.js` e roda em `http://localhost:3000` (porta configurável via `PORT`). Ele foi desenhado para que apenas o administrador tenha controles avançados, enquanto os clientes consomem créditos por meio de uma API segura.

### Acesso do administrador

1. Garanta que `PANEL_USERNAME` e `PANEL_PASSWORD` estejam definidos no `.env`.
2. Inicie o painel com `npm run painel` (ou `npm run dev` para rodar bot + painel juntos).
3. Abra o navegador em `http://localhost:3000` e faça login via autenticação básica.
4. A área inicial oferece:
   - botões para `autoRun`, geração de estatísticas e backup do banco;
   - atualização ao vivo do resumo de contas (total, prontas, em cooldown, comentários nas últimas 24h);
   - visualização dos logs em `/logs`.

### Gerenciamento de clientes e créditos

O cartão **Clientes e créditos** é exclusivo do administrador e permite:

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

- `GET /api/user/me` — retorna dados básicos, status e créditos restantes.
- `POST /api/user/run` — executa comandos seguros. Corpo esperado:

  ```json
  { "command": "autoRun" }
  ```

  Comando suportados: `autoRun` (consome créditos) e `stats` (somente leitura).

Regras importantes:

- Antes de rodar `autoRun`, o cliente precisa informar a própria `rep4repKey` via painel/admin.
- O bot utiliza a key do cliente durante a execução; quando o limite de créditos é alcançado o processo é interrompido automaticamente.
- Se os créditos acabarem no meio do processo, o retorno será `HTTP 402` e nenhuma tarefa adicional será iniciada.

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
