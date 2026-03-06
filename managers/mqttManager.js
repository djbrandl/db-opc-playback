const net = require('net');
const { Aedes } = require('aedes');
const sparkplug = require('sparkplug-payload').get('spBv1.0');

class MqttManager {
	constructor() {
		this.aedes = null;
		this.tcpServer = null;
		this.config = {};
		this.metricDefinitions = []; // SparkplugB metric defs from first row
		this.previousValues = {};    // For RBE comparison
		this.isConfigured = false;
	}

	async startBroker(port = 1883) {
		if (this.tcpServer) {
			await this.stopBroker();
		}

		this.aedes = new Aedes();
		this.tcpServer = net.createServer(this.aedes.handle);

		return new Promise((resolve, reject) => {
			this.tcpServer.listen(port, () => {
				console.log(`MQTT Broker listening on port ${port}`);
				resolve();
			});
			this.tcpServer.on('error', (err) => {
				console.error('MQTT Broker error:', err.message);
				this.aedes.close();
				this.aedes = null;
				this.tcpServer = null;
				reject(err);
			});
		});
	}

	async stopBroker() {
		return new Promise((resolve) => {
			if (this.aedes) {
				this.aedes.close(() => {
					this.aedes = null;
					if (this.tcpServer) {
						this.tcpServer.close(() => {
							this.tcpServer = null;
							resolve();
						});
					} else {
						resolve();
					}
				});
			} else if (this.tcpServer) {
				this.tcpServer.close(() => {
					this.tcpServer = null;
					resolve();
				});
			} else {
				resolve();
			}
		});
	}

	configure({ groupId, edgeNodeId, deviceId, publishSparkplug, publishPlainMqtt, plainMqttBaseTopic }) {
		this.config = {
			groupId: groupId || 'Playback',
			edgeNodeId: edgeNodeId || 'PlaybackNode',
			deviceId: deviceId || 'PlaybackDevice',
			publishSparkplug: publishSparkplug !== false,
			publishPlainMqtt: publishPlainMqtt !== false,
			plainMqttBaseTopic: plainMqttBaseTopic || ''
		};
		this.previousValues = {};
		this.metricDefinitions = [];
		this.isConfigured = true;
	}

	setupMetricsFromData(row) {
		this.metricDefinitions = [];
		for (const [key, value] of Object.entries(row)) {
			let type;
			if (typeof value === 'number' && Number.isFinite(value)) {
				type = 'Double';
			} else if (typeof value === 'boolean') {
				type = 'Boolean';
			} else if (value instanceof Date) {
				type = 'DateTime';
			} else {
				type = 'String';
			}

			// Handle nulls
			if (value === null || value === undefined) {
				type = 'String';
			}

			this.metricDefinitions.push({ name: key, type });
		}
	}

	publishBirth() {
		if (!this.aedes || !this.isConfigured || !this.config.publishSparkplug) return;

		const { groupId, edgeNodeId } = this.config;
		const topic = `spBv1.0/${groupId}/NBIRTH/${edgeNodeId}`;

		const metrics = this.metricDefinitions.map((def) => ({
			name: def.name,
			type: def.type,
			value: this._defaultValueForType(def.type)
		}));

		const payload = sparkplug.encodePayload({
			timestamp: Date.now(),
			metrics
		});

		this._publish(topic, payload);
		console.log(`SparkplugB NBIRTH published to ${topic} (${metrics.length} metrics)`);
	}

	updateMetrics(row, rbe = false) {
		if (!this.aedes || !this.isConfigured) return;

		// Determine changed metrics
		const changedKeys = [];
		for (const key of Object.keys(row)) {
			const newVal = row[key];
			const prevVal = this.previousValues[key];

			if (rbe) {
				// Compare for RBE
				if (newVal instanceof Date && prevVal instanceof Date) {
					if (newVal.getTime() !== prevVal.getTime()) {
						changedKeys.push(key);
					}
				} else if (newVal !== prevVal) {
					changedKeys.push(key);
				}
			} else {
				changedKeys.push(key);
			}
		}

		// Update stored values
		for (const key of Object.keys(row)) {
			this.previousValues[key] = row[key];
		}

		if (changedKeys.length === 0) return;

		// SparkplugB DDATA
		if (this.config.publishSparkplug) {
			this._publishSparkplugData(row, changedKeys);
		}

		// Plain MQTT
		if (this.config.publishPlainMqtt) {
			this._publishPlainMqtt(row, changedKeys);
		}
	}

	_publishSparkplugData(row, changedKeys) {
		const { groupId, edgeNodeId, deviceId } = this.config;
		const topic = `spBv1.0/${groupId}/DDATA/${edgeNodeId}/${deviceId}`;

		const metrics = changedKeys.map((key) => {
			const def = this.metricDefinitions.find((d) => d.name === key);
			const type = def ? def.type : 'String';
			return {
				name: key,
				type,
				value: this._coerceValue(row[key], type)
			};
		});

		const payload = sparkplug.encodePayload({
			timestamp: Date.now(),
			metrics
		});

		this._publish(topic, payload);
	}

	_publishPlainMqtt(row, changedKeys) {
		const { groupId, edgeNodeId, deviceId, plainMqttBaseTopic } = this.config;
		const baseTopic = plainMqttBaseTopic
			? plainMqttBaseTopic
			: `${groupId}/${edgeNodeId}/${deviceId}`;

		for (const key of changedKeys) {
			const topic = `${baseTopic}/${key}`;
			const value = row[key];
			const strValue = value instanceof Date ? value.toISOString() : String(value ?? '');
			this._publish(topic, Buffer.from(strValue, 'utf-8'));
		}
	}

	_publish(topic, payload) {
		if (!this.aedes) return;
		this.aedes.publish({
			topic,
			payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
			qos: 0,
			retain: false
		}, () => {});
	}

	_coerceValue(value, type) {
		if (value === null || value === undefined) {
			return this._defaultValueForType(type);
		}
		switch (type) {
			case 'Double': return typeof value === 'number' ? value : parseFloat(value) || 0;
			case 'Boolean': return Boolean(value);
			case 'DateTime': return value instanceof Date ? value.getTime() : new Date(value).getTime();
			case 'String':
			default: return String(value);
		}
	}

	_defaultValueForType(type) {
		switch (type) {
			case 'Double': return 0;
			case 'Boolean': return false;
			case 'DateTime': return Date.now();
			case 'String':
			default: return '';
		}
	}
}

module.exports = new MqttManager();
