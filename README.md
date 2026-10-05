# Mercado Virtual — Arduino → Leituras → Prateleiras

## Fluxo atual

```text
Arduino + HX711
      ↓ USB
serial_bridge.py
      ↓ Internet + token
Railway / backend
      ↓
📡 Leituras recebidas do Arduino
      ↓ gerente escolhe
🗺️ Prateleira do mapa + produto (opcional)
```

O Arduino **não escolhe mais a prateleira do mapa**. Ele envia apenas seu identificador (`ARDUINO_01`), o slot, o peso e a porcentagem.

## Estrutura

- `server.js` — backend Express + SQLite
- `public/index.html` — site
- `arduino_prateleira(1).ino` — código do Arduino/HX711
- `serial_bridge.py` — ponte USB → API
- `package.json` — configuração do Railway/Node

## Railway

O repositório deve ter `package.json` e `server.js` na raiz.

Start command:

```text
npm start
```

O servidor usa `process.env.PORT` automaticamente.

## Arduino

No código:

```cpp
const char ARDUINO_ID[] = "ARDUINO_01";
```

Esse valor é somente o nome do dispositivo. Para outro Arduino, troque por outro identificador, por exemplo `ARDUINO_02`.

A prateleira é escolhida **somente pelo gerente no site**.

## Calibração

Com o `serial_bridge.py` rodando, digite:

```text
C
```

Retire o peso quando solicitado. Depois coloque o peso conhecido e digite seu valor, por exemplo:

```text
500
```

O bridge agora permite valores numéricos durante a calibração, em vez de aceitar somente os comandos E/L/T/C/Q.

A calibração mostra o fator calculado. Se quiser deixar o fator permanente, copie o valor mostrado para `FATOR[]` no `.ino` e faça novo upload.

## Token

No site, entre como gerente → **⚙️ Configurações** → **Conexão com o Arduino** → **Gerar token**.

Cole o token em `HW_TOKEN` no `serial_bridge.py`.

## Executar bridge

Instale:

```bash
pip install pyserial requests
```

Depois:

```bash
python serial_bridge.py
```

Não deixe o Monitor Serial do Arduino IDE aberto ao mesmo tempo, porque a mesma porta USB não pode ser usada pelos dois programas.


### Calibração pelo Serial Bridge

Use `C` no terminal do `serial_bridge.py`. Depois que o Arduino fizer a tara
e pedir o peso conhecido, digite somente o valor, por exemplo `500`.
O bridge possui uma única thread lendo o teclado, evitando conflitos durante
a calibração.
