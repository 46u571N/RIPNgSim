# Simulador Interactivo de RIPng

## Descripción

Este proyecto es una aplicación web interactiva diseñada para simular el protocolo de enrutamiento **RIPng (Routing Information Protocol next generation)** para IPv6. Permite a los usuarios visualizar y comprender cómo los routers intercambian información de enrutamiento, cómo se construyen las tablas de enrutamiento y cómo reaccionan a los cambios en la topología de la red, como fallos de enlace. El simulador está implementado completamente en el lado del cliente utilizando HTML, CSS y JavaScript puro, y está enfocado en ser una herramienta educativa.

La simulación se basa en una topología fija de cuatro routers (R1, R2, R3, R4) interconectados a través de tres segmentos de red (simulando switches S1, S2, S3), tal como se muestra en la imagen de topología incluida en la interfaz.

## Características Principales

* **Simulación de RIPng:** Simula el comportamiento básico del protocolo RIPng.
* **Topología Fija:** Presenta una topología de 4 routers con una imagen de referencia en la interfaz.
* **Tablas de Enrutamiento Dinámicas:** Muestra en tiempo real las tablas de enrutamiento IPv6 para cada uno de los cuatro routers, incluyendo:
    * Prefijo de Red
    * Siguiente Salto (Dirección Link-Local)
    * Métrica (Número de saltos)
    * Interfaz de Salida
    * Temporizador de expiración (Timeout)
* **Timers Configurables:** Permite al usuario ajustar los siguientes timers de RIPng:
    * `Update Timer`: Intervalo entre actualizaciones periódicas.
    * `Invalid Timer`: Tiempo para que una ruta se marque como inválida si no se reciben actualizaciones.
    * `Flush Timer`: Tiempo después de ser inválida para que una ruta sea eliminada de la tabla.
* **Control de Funcionalidades de RIPng:**
    * `Split Horizon`: Habilitar/deshabilitar.
    * `Poison Reverse`: Habilitar/deshabilitar (como una opción de Split Horizon).
    * `Triggered Updates`: Habilitar/deshabilitar actualizaciones inmediatas ante cambios.
* **Simulación de Fallos de Enlace:** Permite al usuario activar o desactivar manualmente los enlaces de comunicación entre los routers para observar la reconvergencia de la red.
* **Controles de Simulación:**
    * `Iniciar`: Comienza la simulación.
    * `Pausar`: Detiene temporalmente la simulación.
    * `Paso (1s)`: Avanza la simulación en un segundo.
    * `Reiniciar`: Restaura la simulación a su estado inicial.
* **Registro de Eventos:** Un panel muestra en orden cronológico los eventos clave de la simulación, como el envío y recepción de actualizaciones, cambios en las rutas y fallos de enlace.
* **Indicadores Visuales:**
    * Estado de los enlaces (Activo/Inactivo).
    * Indicador visual cuando un router envía una actualización.

## Conceptos de RIPng Implementados

* Métrica basada en el conteo de saltos (hop count).
* Actualizaciones periódicas.
* Actualizaciones disparadas (triggered updates) por cambios en la red.
* Invalidación de rutas (métrica 16) por timeout.
* Eliminación de rutas de la tabla (garbage collection).
* Mecanismo de Split Horizon y Poison Reverse para ayudar a prevenir bucles de enrutamiento.
* Uso de la métrica 16 para indicar rutas inalcanzables.

## Tecnologías Utilizadas

* **HTML5:** Para la estructura de la página web.
* **CSS3:** Para los estilos y la presentación visual.
* **JavaScript (ES6+):** Para toda la lógica de la simulación, manipulación del DOM y la interactividad.
* No se utilizan frameworks o librerías externas para la lógica principal de la simulación.

## Estructura de Archivos

* `index.html`: El archivo principal HTML que estructura la página.
* `style.css`: La hoja de estilos CSS.
* `script.js`: El código JavaScript que contiene la lógica del simulador.
* `image_140557.png`: La imagen de la topología de red utilizada en la interfaz.

## Cómo Utilizar

1.  **Descargar los Archivos:** Clona o descarga todos los archivos (`index.html`, `style.css`, `script.js`, `image_140557.png`) en un mismo directorio en tu computadora.
2.  **Abrir en el Navegador:** Abre el archivo `index.html` en un navegador web moderno (como Chrome, Firefox, Edge, etc.).
3.  **Interactuar con el Simulador:**
    * **Imagen de Topología:** Observa la imagen en la parte superior para entender las conexiones.
    * **Controles Globales:** Ajusta los timers y las funcionalidades de RIPng (Split Horizon, Triggered Updates) según desees antes de iniciar la simulación o mientras está pausada.
    * **Estado de Enlaces:** Utiliza los botones para activar o desactivar los enlaces entre los routers. Se recomienda pausar la simulación para realizar estos cambios y luego observar el efecto.
    * **Botones de Simulación:** Utiliza "Iniciar", "Pausar", "Paso" y "Reiniciar" para controlar el flujo de la simulación.
    * **Tiempo de Simulación:** Observa el avance del tiempo simulado.
    * **Paneles de Routers:** Monitoriza las tablas de enrutamiento de R1, R2, R3 y R4 para ver cómo aprenden y actualizan las rutas. Presta atención a las métricas y los timeouts.
    * **Registro de Eventos:** Sigue los mensajes en el log para entender las acciones que ocurren en segundo plano (envío/recepción de paquetes, invalidación de rutas, etc.).

## Posibles Mejoras Futuras

* Visualización gráfica interactiva de la topología (usando librerías como Vis.js o Cytoscape.js).
* Animación del envío de paquetes sobre la topología gráfica.
* Posibilidad de crear/modificar topologías personalizadas.
* Guardar y cargar configuraciones de simulación.
* Implementación de más detalles del RFC 2080 para RIPng.
* Soporte para otros protocolos de enrutamiento para comparación.

---

Este simulador es una herramienta con fines educativos para facilitar la comprensión de los principios básicos de RIPng.
