const { OPCUAServer, Variant, DataType, StatusCodes } = require("node-opcua");

class OpcManager {
    constructor() {
        this.server = null;
        this.addressSpace = null;
        this.namespace = null;
        this.deviceObject = null;
        this.variables = {}; // Map of tagName -> UAVariable
        this.tagValues = {}; // Map of tagName -> Current Value
        this.tagTypes = {};  // Map of tagName -> DataType Enum
        this.isInitialized = false;
    }

    async startServer(port = 4334) {
        if (this.server) {
            await this.server.shutdown();
        }

        this.server = new OPCUAServer({
            port: port,
            resourcePath: "/UA/PlaybackServer",
            buildInfo: {
                productName: "DB-OPC Playback",
                buildNumber: "1",
                buildDate: new Date()
            }
        });

        await this.server.initialize();
        this.startInternal();
        this.isInitialized = true;
        console.log(`OPC UA Server initialized on port ${port}`);
    }

    startInternal() {
        this.server.start(() => {
            console.log("OPC UA Server is now listening... (press CTRL+C to stop)");
            console.log("port ", this.server.endpoints[0].port);
            const endpointUrl = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl;
            console.log(" the primary server endpoint url is ", endpointUrl );
        });
    }

    // Improved setup that takes a sample row to infer types
    setupAddressSpaceFromData(row) {
         if (!this.isInitialized) return;

        this.addressSpace = this.server.engine.addressSpace;
        this.namespace = this.addressSpace.getOwnNamespace();

        if (this.deviceObject) {
            this.addressSpace.deleteNode(this.deviceObject.nodeId);
            this.variables = {};
            this.tagValues = {};
            this.tagTypes = {};
        }

        this.deviceObject = this.namespace.addObject({
            organizedBy: this.addressSpace.rootFolder.objects,
            browseName: "PlaybackDevice"
        });

        for (const [key, value] of Object.entries(row)) {
            let dataType = DataType.String;
            let initialValue = value;

            if (typeof value === 'number') {
                dataType = DataType.Double;
            } else if (typeof value === 'boolean') {
                dataType = DataType.Boolean;
            } else if (value instanceof Date) {
                dataType = DataType.DateTime;
            }

            // Handle nulls in first row gracefully
            if (value === null) {
                dataType = DataType.String;
                initialValue = "";
            }

            // Store metadata
            this.tagValues[key] = initialValue;
            this.tagTypes[key] = dataType;

            const variable = this.namespace.addVariable({
                componentOf: this.deviceObject,
                nodeId: `s=${key}`, // Use String NodeId for easier discovery (ns=1;s=tagName)
                browseName: key,
                dataType: dataType,
                value: {
                    get: () => {
                        return new Variant({ dataType, value: this.tagValues[key] });
                    }
                }
            });
            
            this.variables[key] = variable;
        }
    }

    updateTags(row, rbe = false) {
        for (const [key, value] of Object.entries(row)) {
            // Check if value changed
            const previousValue = this.tagValues[key];
            const valueChanged = previousValue !== value;

            // Update the stored value regardless (so next check is correct)
            this.tagValues[key] = value;
            
            // Skip update if RBE is on and value hasn't changed
            if (rbe && !valueChanged) {
                continue;
            }

            // Notify subscription if variable exists
            if (this.variables[key]) {
                const dataType = this.tagTypes[key] || DataType.String;
                
                // Ensure value is compatible if needed, or rely on Variant's auto-conversion if possible.
                // For safety, handle nulls for Double/Boolean types if they occur in stream but not first row.
                let safeValue = value;
                if (value === null || value === undefined) {
                     // Provide defaults to prevent Variant crash
                     if (dataType === DataType.Double) safeValue = 0;
                     else if (dataType === DataType.Boolean) safeValue = false;
                     else if (dataType === DataType.DateTime) safeValue = new Date();
                     else safeValue = "";
                }

                this.variables[key].setValueFromSource(new Variant({
                    dataType: dataType,
                    value: safeValue
                }));
            }
        }
    }
}

module.exports = new OpcManager();
