# 🤖 Rep4Rep Bot CLI + Painel Web

Automação de comentários no Steam via integração com o [Rep4Rep.com](https://rep4rep.com), com gerenciamento de múltiplos perfis e painel web para facilitar o uso. Agora com estatísticas, backup, verificação de status e mais!

---

## 🛠️ Requisitos

- Node.js v18+ 🔧
- Conta no site [rep4rep.com](https://rep4rep.com)
- Arquivo `.env` corretamente configurado
- Arquivo `accounts.txt` com credenciais no formato:
  ```
  username:password:shared_secret
  ```

---

## 📁 Estrutura

```
📦 root
├── main.cjs               # Interface CLI
├── src/
│   ├── util.cjs           # Funções principais do bot
│   ├── api.cjs            # Wrapper para API do Rep4Rep
│   ├── steamBot.cjs       # Lógica de login e comentários Steam
│   └── db.cjs             # Banco de dados SQLite
├── web/                   # Painel web (Express + EJS + CSS/JS)
├── data/users.json        # Base de clientes/créditos (preview)
├── accounts.txt           # Lista de contas Steam
├── .env                   # Configuração do bot
├── steamprofiles.db       # Banco de dados de perfis
└── logs/                  # Logs automáticos do bot
```

---

## 🚀 Comandos (main.cjs)

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

## 🌐 Painel Web

### 📁 Local: `web/server.js`

**Recursos:**
- Layout moderno, responsivo e com feedback visual das ações
- Botões para autoRun, estatísticas e backup com resultado em tempo real
- Pré-visualização de um módulo de clientes/créditos (pensado para o futuro painel público)
- Visualização dos últimos logs em cartões elegantes
- Autenticação com login e senha via `.env`

### ✅ Acesso:
Abra no navegador: [http://localhost:3000](http://localhost:3000)

---

## ⚙️ .env (Exemplo Completo)

```env
# Token da API do Rep4Rep
REP4REP_KEY=seu_token_api

# Tempo entre logins (em ms)
LOGIN_DELAY=30000

# Tempo entre comentários (em ms)
COMMENT_DELAY=15000

# Quantidade máxima de comentários por perfil a cada execução
MAX_COMMENTS_PER_RUN=10

# Login do painel web (ou use PANEL_USER/PANEL_PASS para retrocompatibilidade)
PANEL_USERNAME=admin
PANEL_PASSWORD=senha123
```

---

## 📦 Scripts no package.json

| Comando        | Descrição                           |
|----------------|-------------------------------------|
| `npm run bot`     | Inicia apenas o bot (CLI)           |
| `npm run painel`  | Inicia o painel Web                |
| `npm run dev`     | Inicia bot e painel ao mesmo tempo  |
| `npm start`       | Abre o navegador + bot + painel     |

### 💳 Gestão de créditos (preview)

O painel agora traz um módulo experimental para administrar clientes e créditos (pensado para a futura monetização):

- Arquivo `data/users.json` com os cadastros. Um seed "Cliente Demo" é criado automaticamente.
- Formulário para adicionar clientes, e botões para ajustar créditos em tempo real.
- Essa base ainda é interna (apenas o administrador vê), mas já foi projetada para evoluir para um portal onde o cliente terá login próprio.

> **Dica:** mantenha o arquivo `data/users.json` fora do controle de versão público quando for trabalhar com dados reais.

---

## 🆘 Suporte

Se tiver algum erro:
- Verifique o `.env`
- Verifique se suas contas estão no formato correto
- Confira os logs na pasta `logs/`

---

## ✨ Sugestões futuras

- Integração com Telegram 📲
- Painel Web com autenticação 🔒
- Exportar comentários e histórico 🔍