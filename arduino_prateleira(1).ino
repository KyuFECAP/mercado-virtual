/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║      PRATELEIRA INTELIGENTE — Arduino UNO (simples)         ║
 * ║      Somente HX711 + Serial USB → script Python             ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * FUNÇÃO:
 *   Lê uma célula de carga via HX711 e envia os dados
 *   pela porta USB serial para o script serial_bridge.py
 *   rodando no PC, que repassa ao backend do Mercado Virtual.
 *
 * BIBLIOTECA NECESSÁRIA (só uma):
 *   • HX711 by Bogdan Necula
 *     Arduino IDE → Sketch → Incluir Biblioteca →
 *     Gerenciar Bibliotecas → busque "HX711 Arduino Library"
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │                  DIAGRAMA DE PINOS                      │
 * │                                                         │
 * │  HX711 #1  DOUT ──── D2      CLK ──── D3               │
 * │  HX711 #2  DOUT ──── D4      CLK ──── D5               │
 * │  HX711 #3  DOUT ──── D6      CLK ──── D7               │
 * │                                                         │
 * │  Todos os HX711:  VCC ── 3.3V do Arduino               │
 * │                   GND ── GND do Arduino                 │
 * │                                                         │
 * │  LIGAÇÃO DA CÉLULA DE CARGA AO HX711:                   │
 * │    Vermelho → E+    Preto  → E-                         │
 * │    Branco   → A-    Verde  → A+                         │
 * │                                                         │
 * │  Alimentação: cabo USB ligado no PC                     │
 * └─────────────────────────────────────────────────────────┘
 */

#include <HX711.h>

// ═══════════════════════════════════════════════════════════
//   CONFIGURAÇÃO — edite aqui antes de fazer upload
// ═══════════════════════════════════════════════════════════

// Identificação deste Arduino.
// NÃO é uma coordenada da prateleira e não escolhe o destino no mapa.
const char ARDUINO_ID[] = "ARDUINO_01";

// Quantos slots (células de carga): 1, 2 ou 3
#define NUM_SLOTS 1

// Intervalo de envio em milissegundos
// 300000 = 5 minutos | Use 10000 (10s) durante os testes
#define INTERVALO_ENVIO 300000UL

// Peso em gramas quando o slot está CHEIO (produto novo)
float PESO_CHEIO[NUM_SLOTS] = { 400.0 };

// Peso em gramas quando o slot está VAZIO (só a bandeja)
// Ajuste após apertar 'T' no Monitor Serial com bandejas vazias
float PESO_VAZIO[NUM_SLOTS] = { 0.0 };

// Fator de calibração de cada célula
// Obtenha apertando 'C' no Monitor Serial e seguindo os passos
// Depois copie os valores aqui e faça upload novamente
float FATOR[NUM_SLOTS] = { -411.0 };

// ─── Pinos ───────────────────────────────────────────────────
const uint8_t DOUT[NUM_SLOTS] = { 2 };
const uint8_t CLK[NUM_SLOTS]  = { 3 };

// ═══════════════════════════════════════════════════════════
//   VARIÁVEIS INTERNAS
// ═══════════════════════════════════════════════════════════

HX711         balanca[NUM_SLOTS];
float         pesoAtual[NUM_SLOTS] = {0};
uint8_t       pctAtual[NUM_SLOTS]  = {0};
unsigned long ultimoEnvio          = 0;
unsigned long ultimaLeitura        = 0;
#define INTERVALO_LEITURA 1000UL

// ═══════════════════════════════════════════════════════════
//   SETUP
// ═══════════════════════════════════════════════════════════

void setup() {
  Serial.begin(9600);
  Serial.println(F(""));
  Serial.println(F("=== Prateleira Inteligente ==="));
  Serial.print(F("Arduino  : ")); Serial.println(ARDUINO_ID);
  Serial.print(F("Slots    : ")); Serial.println(NUM_SLOTS);
  Serial.println(F("Comandos : C=calibrar | T=tara | E=enviar agora | L=leitura"));
  Serial.println(F(""));

  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    balanca[i].begin(DOUT[i], CLK[i]);
    balanca[i].set_scale(FATOR[i]);
    balanca[i].tare();
    Serial.print(F("HX711 #")); Serial.print(i + 1); Serial.println(F(" pronto"));
  }

  Serial.println(F(""));
  Serial.println(F("Aguardando leituras..."));
}

// ═══════════════════════════════════════════════════════════
//   LOOP PRINCIPAL
// ═══════════════════════════════════════════════════════════

void loop() {
  if (Serial.available()) {
    char cmd = tolower(Serial.read());
    while (Serial.available()) Serial.read();
    switch (cmd) {
      case 'c': calibrar();         break;
      case 't': tara();             break;
      case 'e': enviarDados();      break;
      case 'l': imprimirLeituras(); break;
    }
  }

  unsigned long agora = millis();

  if (agora - ultimaLeitura >= INTERVALO_LEITURA) {
    lerSensores();
    ultimaLeitura = agora;
  }

  if (agora - ultimoEnvio >= INTERVALO_ENVIO) {
    enviarDados();
    ultimoEnvio = agora;
  }
}

// ═══════════════════════════════════════════════════════════
//   LEITURA DOS SENSORES
// ═══════════════════════════════════════════════════════════

void lerSensores() {
  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    if (!balanca[i].is_ready()) continue;

    float leitura = balanca[i].get_units(3);
    pesoAtual[i]  = max(0.0f, leitura);

    float amplitude = PESO_CHEIO[i] - PESO_VAZIO[i];
    if (amplitude > 0) {
      float pct = ((pesoAtual[i] - PESO_VAZIO[i]) / amplitude) * 100.0f;
      pctAtual[i] = (uint8_t) constrain((int)pct, 0, 100);
    } else {
      pctAtual[i] = 0;
    }
  }
}

void imprimirLeituras() {
  Serial.println(F("--- Leitura atual ---"));
  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    Serial.print(F("  Slot ")); Serial.print(i + 1);
    Serial.print(F(": "));     Serial.print(pesoAtual[i], 1); Serial.print(F(" g"));
    Serial.print(F("  ("));    Serial.print(pctAtual[i]);     Serial.println(F("%)"));
  }
}

// ═══════════════════════════════════════════════════════════
//   ENVIO — JSON pela porta serial USB
// ═══════════════════════════════════════════════════════════
// Formato lido pelo serial_bridge.py:
// {"arduino_id":"ARDUINO_01","slots":[{"slot":1,"peso":385.2,"pct":96},...]}

void enviarDados() {
  lerSensores();

  String json = "{\"arduino_id\":\"";
  json += ARDUINO_ID;
  json += "\",\"slots\":[";

  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    if (i > 0) json += ",";
    json += "{\"slot\":";    json += (i + 1);
    json += ",\"peso\":";    json += String(pesoAtual[i], 1);
    json += ",\"pct\":";     json += pctAtual[i];
    json += "}";
  }

  json += "]}";

  Serial.println(json);   // lido pelo serial_bridge.py

  Serial.println(F("--- Enviado ---"));
  imprimirLeituras();

  ultimoEnvio = millis();
}

// ═══════════════════════════════════════════════════════════
//   TARA
// ═══════════════════════════════════════════════════════════

void tara() {
  Serial.println(F("Retire os produtos e aguarde 3s..."));
  delay(3000);
  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    balanca[i].tare();
    PESO_VAZIO[i] = 0.0;
  }
  Serial.println(F("Tara concluida."));
}

// ═══════════════════════════════════════════════════════════
//   CALIBRAÇÃO GUIADA
// ═══════════════════════════════════════════════════════════

void calibrar() {
  Serial.println(F(""));
  Serial.println(F("=== CALIBRACAO ==="));
  Serial.println(F("Passo 1: retire TUDO dos slots e aguarde 3s..."));
  delay(3000);

  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    balanca[i].set_scale();
    balanca[i].tare();
  }
  Serial.println(F("Tara feita."));
  Serial.println(F("Passo 2: coloque um peso CONHECIDO em todos os slots."));
  Serial.println(F("Digite o peso em gramas e pressione Enter. Ex: 500"));
  while (!Serial.available()) delay(50);
  float ref = Serial.parseFloat();
  while (Serial.available()) Serial.read();

  if (ref <= 0) { Serial.println(F("Invalido. Cancelado.")); return; }

  Serial.println(F(""));
  Serial.println(F("Copie os valores abaixo para FATOR[] no codigo:"));
  Serial.println(F("------------------------------------------------"));

  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    float fator  = balanca[i].get_units(20) / ref;
    FATOR[i]     = fator;
    balanca[i].set_scale(fator);
    Serial.print(F("  FATOR[")); Serial.print(i);
    Serial.print(F("] = "));     Serial.println(fator, 4);
  }

  Serial.println(F("------------------------------------------------"));
  Serial.println(F("Se quiser tornar o fator permanente, copie o valor mostrado para FATOR[] e faca upload novamente."));
  Serial.println(F(""));
}

