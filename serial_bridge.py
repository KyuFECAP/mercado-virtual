"""
╔══════════════════════════════════════════════════════════════╗
║        PRATELEIRA INTELIGENTE — Serial Bridge v2            ║
║        Arduino UNO → USB → PC → Backend Mercado Virtual     ║
╚══════════════════════════════════════════════════════════════╝

INSTALAÇÃO:
  pip install pyserial requests

COMO RODAR:
  python serial_bridge.py           → modo normal
  python serial_bridge.py --teste   → testa conexão com backend sem Arduino
  python serial_bridge.py --raw     → mostra TUDO que chega do Arduino (debug)
"""

import serial
import serial.tools.list_ports
import requests
import json
import time
import sys
import argparse
import threading
from datetime import datetime

# ══════════════════════════════════════════════════════════════
#   CONFIGURAÇÃO — edite aqui antes de rodar
# ══════════════════════════════════════════════════════════════

BACKEND_URL  = "https://SEU-SITE.up.railway.app/api/shelves/weight"
HW_TOKEN     = "COLE_SEU_TOKEN_AQUI"
PORTA_SERIAL = None     # None = detecta automaticamente | ex: "COM3"
BAUD_RATE    = 9600

# ══════════════════════════════════════════════════════════════
#   UTILITÁRIOS
# ══════════════════════════════════════════════════════════════

def agora():
    return datetime.now().strftime("%H:%M:%S")

def linha(char="─", n=60):
    print(char * n)

def ok(msg):    print(f"  ✅  {msg}")
def erro(msg):  print(f"  ❌  {msg}")
def aviso(msg): print(f"  ⚠   {msg}")
def info(msg):  print(f"  ℹ   {msg}")

# ══════════════════════════════════════════════════════════════
#   VALIDAÇÃO DA CONFIGURAÇÃO
# ══════════════════════════════════════════════════════════════

def validar_config():
    problemas = []
    if "SEU-SITE" in BACKEND_URL:
        problemas.append("BACKEND_URL não foi configurada — substitua pela URL do seu site")
    if "COLE_SEU_TOKEN" in HW_TOKEN:
        problemas.append("HW_TOKEN não foi configurado — gere um token no painel do gerente")
    if problemas:
        linha("═")
        print("  CONFIGURAÇÃO INCOMPLETA")
        linha("═")
        for p in problemas:
            erro(p)
        print()
        info("Edite as linhas BACKEND_URL e HW_TOKEN no início deste arquivo.")
        linha()
        sys.exit(1)

# ══════════════════════════════════════════════════════════════
#   TESTE DE CONEXÃO COM O BACKEND
# ══════════════════════════════════════════════════════════════

def testar_backend():
    """
    Envia uma leitura FALSA para verificar se o backend
    está aceitando conexões e o token está correto.
    Útil para confirmar que a URL e o token estão certos
    antes de ligar o Arduino.
    """
    linha("═")
    print("  TESTE DE CONEXÃO COM O BACKEND")
    linha("═")
    print(f"  URL   : {BACKEND_URL}")
    print(f"  Token : {HW_TOKEN[:8]}...{HW_TOKEN[-4:]}")
    linha()

    dados_teste = {
        "arduino_id": "ARDUINO_TESTE",
        "slots": [
            {"slot": 1, "peso": 999.9, "pct": 99}
        ]
    }

    print(f"  Enviando dados de TESTE para o backend...")
    print(f"  JSON: {json.dumps(dados_teste)}")
    linha()

    try:
        resp = requests.post(
            BACKEND_URL,
            json=dados_teste,
            headers={"Authorization": f"Bearer {HW_TOKEN}"},
            timeout=10
        )
        if resp.status_code == 200:
            ok(f"Backend respondeu OK (200) — conexão funcionando!")
            ok("Token aceito pelo servidor.")
            info("Abra a aba 'Leituras recebidas do Arduino' para ver o teste.")
        elif resp.status_code == 401:
            erro(f"Token inválido (401) — verifique o HW_TOKEN")
            info("Gere um novo token no painel do gerente → 'Conexão com o Arduino'")
        elif resp.status_code == 403:
            erro(f"Acesso negado (403) — token sem permissão")
        else:
            erro(f"Backend retornou status {resp.status_code}: {resp.text[:200]}")

    except requests.exceptions.ConnectionError:
        erro("Não conseguiu conectar ao backend.")
        info(f"Verifique se o site está no ar: {BACKEND_URL.split('/api')[0]}")
        info("Tente abrir a URL acima no navegador.")
    except requests.exceptions.Timeout:
        erro("Timeout — o backend demorou mais de 10 segundos.")
        info("O site pode estar 'dormindo' (Render free tier). Abra no navegador e tente de novo.")
    except Exception as e:
        erro(f"Erro inesperado: {e}")

    linha()
    sys.exit(0)

# ══════════════════════════════════════════════════════════════
#   DETECÇÃO DA PORTA DO ARDUINO
# ══════════════════════════════════════════════════════════════

def detectar_porta():
    portas = list(serial.tools.list_ports.comports())

    if not portas:
        erro("Nenhuma porta serial encontrada.")
        info("Verifique se o Arduino está conectado via USB.")
        sys.exit(1)

    info(f"{len(portas)} porta(s) serial encontrada(s):")
    for p in portas:
        print(f"       {p.device}  —  {p.description}")
    linha()

    # Tenta identificar Arduino automaticamente
    for p in portas:
        desc = (p.description or "").lower()
        if any(x in desc for x in ["arduino", "ch340", "ch341", "ftdi", "usb serial", "usb-serial"]):
            ok(f"Arduino detectado automaticamente: {p.device}")
            return p.device

    # Não achou automaticamente
    aviso("Não foi possível identificar o Arduino automaticamente.")
    for i, p in enumerate(portas):
        print(f"  [{i}] {p.device}  —  {p.description}")
    try:
        escolha = int(input("\n  Digite o número da porta do Arduino: "))
        return portas[escolha].device
    except (ValueError, IndexError):
        erro("Opção inválida.")
        sys.exit(1)

# ══════════════════════════════════════════════════════════════
#   ENVIO PARA O BACKEND
# ══════════════════════════════════════════════════════════════

# Estatísticas da sessão
stats = {"enviados": 0, "erros": 0, "recebidos": 0, "inicio": datetime.now()}
calibrando = False

def enviar(dados: dict, modo_raw: bool = False) -> bool:
    try:
        resp = requests.post(
            BACKEND_URL,
            json=dados,
            headers={"Authorization": f"Bearer {HW_TOKEN}"},
            timeout=10
        )
        if resp.status_code == 200:
            stats["enviados"] += 1
            slots = dados.get("slots", [])
            resumo = "  ".join(
                f"slot{s['slot']}: {s['peso']}g ({s['pct']}%)" for s in slots
            )
            ok(f"[{agora()}] {dados.get('arduino_id', dados.get('shelf_id', 'Arduino'))} → {resumo}")
            return True
        elif resp.status_code == 401:
            stats["erros"] += 1
            erro(f"[{agora()}] Token inválido — verifique HW_TOKEN")
            return False
        else:
            stats["erros"] += 1
            erro(f"[{agora()}] HTTP {resp.status_code}: {resp.text[:100]}")
            return False

    except requests.exceptions.ConnectionError:
        stats["erros"] += 1
        erro(f"[{agora()}] Sem conexão com o backend")
        info(f"          URL: {BACKEND_URL}")
        return False
    except requests.exceptions.Timeout:
        stats["erros"] += 1
        erro(f"[{agora()}] Timeout ao contatar o backend")
        return False
    except Exception as e:
        stats["erros"] += 1
        erro(f"[{agora()}] Erro inesperado: {e}")
        return False

# ══════════════════════════════════════════════════════════════
#   PROCESSAMENTO DO JSON RECEBIDO DO ARDUINO
# ══════════════════════════════════════════════════════════════

def processar_linha(linha_str: str, modo_raw: bool):
    stats["recebidos"] += 1

    # Linha de debug do Arduino (não é JSON)
    if not linha_str.startswith("{"):
        print(f"  [Arduino {agora()}] {linha_str}")
        return

    # Linha JSON
    try:
        dados = json.loads(linha_str)
    except json.JSONDecodeError as e:
        aviso(f"JSON inválido: {e}")
        aviso(f"Conteúdo recebido: {linha_str[:80]}")
        return

    if ("arduino_id" not in dados and "shelf_id" not in dados) or "slots" not in dados:
        aviso(f"JSON sem campos arduino_id/shelf_id ou slots: {linha_str[:80]}")
        return

    if not isinstance(dados["slots"], list) or len(dados["slots"]) == 0:
        aviso("JSON com lista de slots vazia.")
        return

    if modo_raw:
        print(f"\n  JSON completo recebido:")
        print(f"  {json.dumps(dados, indent=4, ensure_ascii=False)}")

    enviar(dados, modo_raw)

# ══════════════════════════════════════════════════════════════
#   LOOP PRINCIPAL
# ══════════════════════════════════════════════════════════════

def main(modo_raw: bool):
    linha("═")
    print("  PRATELEIRA INTELIGENTE — Serial Bridge")
    linha("═")
    print(f"  URL   : {BACKEND_URL}")
    print(f"  Token : {HW_TOKEN[:8]}...{HW_TOKEN[-4:]}")
    print(f"  Baud  : {BAUD_RATE}")
    linha()

    porta = PORTA_SERIAL or detectar_porta()

    print(f"\n  Conectando em {porta}...")
    try:
        ser = serial.Serial(porta, BAUD_RATE, timeout=2)
        time.sleep(2)           # aguarda Arduino reiniciar
        ser.reset_input_buffer()
        ok(f"Porta {porta} aberta com sucesso")
    except serial.SerialException as e:
        erro(f"Não foi possível abrir a porta: {e}")
        info("Verifique se o Arduino IDE está fechado (não pode usar a mesma porta ao mesmo tempo).")
        sys.exit(1)

    if modo_raw:
        aviso("Modo RAW ativo — mostrando TUDO que chega do Arduino")

    linha()
    print(f"  Aguardando dados do Arduino... (Ctrl+C para sair)")
    print(f"  Dica: digite E + Enter aqui mesmo para forçar um envio agora.")
    print(f"  (Não use o Serial Monitor do Arduino IDE enquanto este script estiver rodando)")
    linha()

    buffer = ""
    ultimo_heartbeat = time.time()

    # ── ÚNICA thread de comandos pelo terminal ─────────────────
    # Importante: existe somente uma thread lendo input().
    # Isso evita que o comando "C" e o peso "500" sejam capturados
    # por threads diferentes durante a calibração.
    def escutar_terminal():
        global calibrando

        print("  Comandos disponíveis neste terminal:")
        print("    E = forçar envio ao backend agora")
        print("    L = mostrar leitura atual")
        print("    T = refazer tara")
        print("    C = calibrar")
        print("    S = status da conexão")
        print("    Q = encerrar o bridge")
        print()

        while True:
            try:
                cmd = input().strip()

                # Durante a calibração, o próximo input deve ser
                # exclusivamente o peso conhecido.
                if calibrando:
                    try:
                        valor = float(cmd.replace(",", "."))
                        if valor <= 0:
                            print("  ⚠ Digite um peso maior que zero. Ex.: 500")
                            continue

                        ser.write((cmd.replace(",", ".") + "\\n").encode())
                        calibrando = False
                        print(f"  [{agora()}] Peso de calibração enviado: {valor:g} g")
                    except ValueError:
                        print("  ⚠ Valor inválido. Digite somente o peso em gramas. Ex.: 500")
                    continue

                cmd = cmd.upper()

                if cmd == "Q":
                    print(f"  [{agora()}] Encerrando...")
                    ser.close()
                    import os
                    os._exit(0)

                elif cmd == "E":
                    ser.write(b"E\\n")
                    print(f"  [{agora()}] Comando E enviado ao Arduino")

                elif cmd == "L":
                    ser.write(b"L\\n")
                    print(f"  [{agora()}] Comando L enviado ao Arduino")

                elif cmd == "T":
                    ser.write(b"T\\n")
                    print(f"  [{agora()}] Comando T enviado ao Arduino")

                elif cmd == "C":
                    ser.write(b"C\\n")
                    calibrando = True
                    print(f"  [{agora()}] Calibração iniciada.")
                    print("  O Arduino fará a tara e depois pedirá o peso conhecido.")
                    print("  Quando aparecer o pedido, digite somente o valor, por exemplo: 500")

                elif cmd == "S":
                    duracao = datetime.now() - stats["inicio"]
                    mins = int(duracao.total_seconds() // 60)
                    print(f"\\n  Status [{agora()}]:")
                    print(f"    Porta    : {porta}")
                    print(f"    Em execução há {mins} minutos")
                    print(f"    Enviados : {stats['enviados']}")
                    print(f"    Erros    : {stats['erros']}")
                    print(f"    Recebidos: {stats['recebidos']} linhas do Arduino")
                    print()

                elif cmd:
                    print(f"  ⚠ Comando desconhecido: '{cmd}'")
                    print("  Use E, L, T, C, S ou Q")

            except EOFError:
                break
            except Exception as e:
                print(f"  ⚠ Erro no terminal: {e}")
                break

    t = threading.Thread(target=escutar_terminal, daemon=True)
    t.start()

    while True:
        try:
            if ser.in_waiting:
                byte = ser.read().decode("utf-8", errors="ignore")

                if modo_raw and byte not in ("\n", "\r"):
                    print(byte, end="", flush=True)

                if byte == "\n":
                    linha_str = buffer.strip()
                    buffer = ""
                    if linha_str:
                        processar_linha(linha_str, modo_raw)
                elif byte != "\r":
                    if len(buffer) < 1024:
                        buffer += byte
                    else:
                        aviso("Buffer cheio — possível dado corrompido, descartando.")
                        buffer = ""
            else:
                time.sleep(0.05)

        except KeyboardInterrupt:
            linha()
            print(f"\n  [{agora()}] Encerrado.")
            print(f"  Resumo: {stats['enviados']} enviados | "
                  f"{stats['erros']} erros | "
                  f"{stats['recebidos']} linhas recebidas")
            linha()
            ser.close()
            sys.exit(0)

        except serial.SerialException as e:
            erro(f"[{agora()}] Conexão perdida: {e}")
            info("Tentando reconectar em 5 segundos... (mantenha o USB conectado)")
            ser.close()
            time.sleep(5)
            try:
                ser = serial.Serial(porta, BAUD_RATE, timeout=2)
                ser.reset_input_buffer()
                ok(f"[{agora()}] Reconectado em {porta}")
            except serial.SerialException:
                erro("Falha ao reconectar. Verifique o cabo USB.")

# ══════════════════════════════════════════════════════════════
#   ENTRADA
# ══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Serial Bridge — Arduino → Backend")
    parser.add_argument("--teste", action="store_true",
                        help="Testa a conexão com o backend sem precisar do Arduino")
    parser.add_argument("--raw", action="store_true",
                        help="Mostra tudo que chega do Arduino (útil para debug)")
    args = parser.parse_args()

    validar_config()

    if args.teste:
        testar_backend()
    else:
        main(modo_raw=args.raw)
