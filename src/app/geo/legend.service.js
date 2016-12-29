(() => {
    'use strict';

    /**
     * @module legendService
     * @memberof app.geo
     * @description
     *
     * The `legendService` factory constructs the legend (auto or structured). `LayerRegistry` instantiates `LegendService` providing the current config, layers and legend containers.
     * This service also scrapes layer symbology.
     *
     */
    angular
        .module('app.geo')
        .factory('legendService', legendServiceFactory);

    function legendServiceFactory($translate, $http, $q, $timeout, gapiService, Geo, legendEntryFactory) {

        const legendSwitch = {
            structured: structuredLegendService,
            autopopulate: autoLegendService
        };

        return (config, ...args) => legendSwitch[config.legend.type](config, ...args);

        /**
         * Constrcuts and maintains autogenerated legend.
         * @function autoLegendService
         * @private
         * @param  {Object} config current config
         * @param  {Object} layerRegistry instance of `layerRegistry`
         * @return {Object}        instance of `legendService` for autogenerated legend
         */
        function autoLegendService() { // config, layerRegistry) { // FIXME: remove later if not needed
            // used in default names for service which do not provide one; it resets every time the map is reloaded (bookmark, language switch, projection switch), so it doesn't grow to ridiculous numbers
            let unnamedServiceCounter = 0;

            // maps layerTypes to layer item generators
            // TODO we may want to revisit this since all the keys can be replaced by constant references
            const layerTypeGenerators = {
                esriDynamic: dynamicGenerator,
                esriFeature: featureGenerator,
                esriImage: imageGenerator,
                esriTile: tileGenerator,
                ogcWms: wmsGenerator
            };

            const service = {
                /**
                 * This is legend's invisible root group; to be consumed by toc
                 * @var legend
                 */
                legend: legendEntryFactory.entryGroup(),

                addLayer,
                addPlaceholder
            };

            return service;

            /***/

            /**
             * Parses a dynamic layer object and creates a legend item (with nested groups and symbology).
             * For a dynamic layer, there are two visibility functions:
             *     - `setVisibility`: https://developers.arcgis.com/javascript/jsapi/arcgisdynamicmapservicelayer-amd.html#setvisibility
             *      sets visibility of the whole layer; if this is set to false, using `setVisibleLayers` will not change anything.
             *
             *  - `setVisibleLayers`: https://developers.arcgis.com/javascript/jsapi/arcgisdynamicmapservicelayer-amd.html#setvisiblelayers
             *      sets visibility of sublayers;
             *
             * A tocEntry for a dynamic layer contains subgroups and leaf nodes, each one with a visibility toggle.
             *  - User clicks on leaf's visibility toggle:
             *      toggle visibility of the leaf's layer item.
             *      notify the root group of this dynamic layer.
             *      walk root's children to find out which leaves are visible, omitting any subgroups.
             *      call `setVisibleLayers` on the layer object to change the visibility of the layer.
             *
             *  - User clicks on subgroup's visibility toggle:
             *      toggle visibility of the subgroup item.
             *      toggle all its children (prevent children from notifying the root when they are toggled).
             *      notify the root group of this dynamic layer.
             *      walk root's children to find out which leaves are visible, omitting any subgroups.
             *      call `setVisibleLayers` on the layer object to change the visibility of the layer.
             *
             *  - User clicks on root's visibility toggle:
             *      toggle all its children (prevent children from notifying the root when they are toggled).
             *      walk root's children to find out which leaves are visible, omitting any subgroups.
             *      call `setVisibleLayers` on the layer object to change the visibility of the layer.
             *
             * @function dynamicGenerator
             * @private
             * @param  {Object} layer layer object from `layerRegistry`
             * @return {Object}       legend item
             */
            function dynamicGenerator(layer) {
                const state = legendEntryFactory.dynamicEntryMasterGroup(layer.config, layer, false);
                layer.legendEntry = state;

                // assign feature counts and symbols only to active sublayers
                state.walkItems(layerEntry => {
                    // get the legend from the attrib bundle, use it to derive the symbol
                    layer._attributeBundle[layerEntry.featureIdx.toString()].layerData.then(ld => {

                        if (ld.supportsFeatures) {
                            // since a geoApi generated legend only has one element, we can omit searching layers[] for a match
                            applySymbology(layerEntry, ld.legend.layers[0]);

                            getServiceFeatureCount(`${state.url}/${layerEntry.featureIdx}`).then(count =>
                                // FIXME _layer reference is bad
                                // FIXME geometryType is undefined for dynamic layer children right now
                                applyFeatureCount(layer._layer.geometryType, layerEntry, count));
                        } else {
                            // no features.  show "0 features"
                            applyFeatureCount('generic', layerEntry, 0);

                            // get our legend from the server (as we have no local renderer)
                            mapServerToLocalLegend(state.url, layerEntry.featureIdx).then(legendData => {
                                applySymbology(layerEntry, legendData.layers[0]);
                            });

                            // this will remove the click handler from the legend entry
                            // TODO suggested to make a new state for legend items that makes them
                            // non-interactable until everything in them has loaded
                            delete layerEntry.options.data;
                        }
                    });
                });

                return state;
            }

            /**
             * Parses a tile layer object and creates a legend item (with nested groups and symbology).
             * Uses the same logic as dynamic layers to generate symbology hierarchy.
             * @function tileGenerator
             * @private
             * @param  {Object} layer layer object from `layerRegistry`
             * @return {Object}       legend item
             */
            function tileGenerator(layer) {
                const state = legendEntryFactory.singleEntryItem(layer.config, layer);
                layer.legendEntry = state;

                return state;
            }

            /**
             * Parses feature layer object and create a legend entry with symbology.
             * @function featureGenerator
             * @private
             * @param  {Object} layer layer object from `layerRegistry`
             * @return {Object}       legend item
             */
            function featureGenerator(layer) {
                // generate toc entry
                const state = legendEntryFactory.singleEntryItem(layer.config, layer);
                layer.legendEntry = state;

                if (typeof state.url !== 'undefined') {
                    // assign feature count
                    // FIXME _layer call is bad
                    getServiceFeatureCount(`${state.url}/${state.featureIdx}`).then(count =>
                        applyFeatureCount(layer._layer.geometryType, state, count));
                } else {
                    applyFeatureCount(layer._layer.geometryType, state, layer._layer.graphics.length);
                }

                // FIXME _attributeBundle call is probably bad
                // get the legend from the attrib bundle, use it to derive the symbol
                layer._attributeBundle[state.featureIdx].layerData.then(ld => {
                    // since a geoApi generated legend only has one element, we can omit searching layers[] for a match
                    applySymbology(state, ld.legend.layers[0]);
                });

                return state;
            }

            /**
             * Parses esri image layer object and create a legend entry with symbology.
             * @function imageGenerator
             * @private
             * @param  {Object} layer layer object from `layerRegistry`
             * @return {Object}       legend item
             */
            function imageGenerator(layer) {
                // generate toc entry
                const state = legendEntryFactory.singleEntryItem(layer.config, layer);
                layer.legendEntry = state;

                // get our legend from the server (as we have no local renderer)
                // image server uses 0 as default layer id
                // FIXME in legend-entry.service, function SINGLE_ENTRY_ITEM.init, there is a FIXME to prevent
                // the stripping of the final part of the url for non-feature layers.
                // for now, we correct the issue here. when it is fixed, this function should be re-adjusted
                mapServerToLocalLegend(`${state.url}/${state.featureIdx}`, 0).then(legendData => {
                    applySymbology(state, legendData.layers[0]);
                });

                return state;
            }

            /**
             * Parses WMS layer object and create a legend entry with symbology.
             * @function wmsGenerator
             * @private
             * @param  {Object} layer layer object from `layerRegistry`
             * @return {Object}       legend item
             */
            function wmsGenerator(layer) {
                const state = legendEntryFactory.singleEntryItem(layer.config, layer);
                state.symbology = gapiService.gapi.layer.ogc
                    .getLegendUrls(layer._layer, state.layerEntries.map(le => le.id))
                    .map((imageUri, idx) => {

                        const symbologyItem = {
                            name: null,
                            svgcode: null
                        };

                        const name = state.layerEntries[idx].name || state.layerEntries[idx].id;

                        gapiService.gapi.symbology.generateWMSSymbology(name, imageUri).then(data => {
                            symbologyItem.name = data.name;
                            symbologyItem.svgcode = data.svgcode;
                        });

                        return symbologyItem;
                    });
                layer.legendEntry = state;

                return state;
            }

            /**
             * Add a placeholder for the provided layer.
             *
             * @function addPlaceholder
             * @param {Object} layerRecord object from `layerRegistry` `layers` object
             */
            function addPlaceholder(layerRecord) {
                // set a default service name if one is not provided in the config: fgpv-vpgf/fgpv-vpgf#1248
                if (typeof layerRecord.config.name !== 'string') {
                    layerRecord.config.name = $translate.instant(
                        'toc.layer.unnamed',
                        { count: ++unnamedServiceCounter });
                }

                // TODO: move this to LegendEntry when it is refactored
                const entry = legendEntryFactory.placeholderEntryItem(layerRecord.config, layerRecord);
                layerRecord.legendEntry = entry;

                // find a position where to insert new placeholder based on its sortGroup value
                let position = service.legend.items.findIndex(et => et.sortGroup > entry.sortGroup);
                position = position !== -1 ? position : undefined;
                position = service.legend.add(entry, position);

                console.log(`Inserting placeholder ${entry.name} ${position}`);
                const listener = state => {
                    console.info(`Placeholder listener fired ${state} ${layerRecord.layerId}`);
                    if (!entry.removed && state === Geo.Layer.States.LOADED) {
                        layerRecord.removeStateListener(listener);
                        entry.unbindListeners();
                        // swap the placeholder with the real legendEntry
                        const index = service.legend.remove(entry);
                        addLayer(layerRecord, index);
                    }
                };
                layerRecord.addStateListener(listener);

                return position;
            }

            /**
             * Add a provided layer to the appropriate group.
             *
             * TODO: hide groups with no layers.
             * @function addLayer
             * @param {Object} layer object from `layerRegistry` `layers` object
             * @param {Number} index position to insert layer into the legend
             */
            function addLayer(layer, index) {
                const layerType = layer.config.layerType;
                const entry = layerTypeGenerators[layerType](layer);

                // TODO: move somewhere more appropriate
                // make top level legend entries reorderable via keyboard
                entry.options.reorder = {
                    enabled: true
                };

                console.log(`Inserting legend entry ${entry.name} ${index}`);

                service.legend.add(entry, index);
            }
        }

        // TODO: maybe this should be split into a separate service; it can get messy otherwise in here
        function structuredLegendService() {

        }

        /*
         * TODO: move to geoapi as it's stateless and very specific.
         * Returns the legend information of an ESRI map service.
         *
         * @function getMapServerLegend
         * @param  {String} layerUrl service url (root service, not indexed endpoint)
         * @returns {Promise} resolves in an array of legend data
         *
         */
        function getMapServerLegend(layerUrl) {
            return $http.jsonp(`${layerUrl}/legend?f=json&callback=JSON_CALLBACK`)
                .then(result => {
                    // console.log(legendUrl, index, result);

                    if (result.data.error) {
                        return $q.reject(result.data.error);
                    }
                    return result.data;
                })
                .catch(error => {
                    // TODO: apply default symbology to the layer in question in this case
                    console.error(error);
                });
        }

        /*
         * TODO: move to geoapi as it's stateless and very specific.
         * Our symbology engine works off of renderers. When dealing with layers with no renderers,
         * we need to take server-side legend and convert it to a fake renderer, which lets us
         * leverage all the existing symbology code.
         *
         * @function mapServerLegendToRenderer
         * @param {Object} serverLegend legend json from an esri map server
         * @param {Integer} layerIndex  the index of the layer in the legend we are interested in
         * @returns {Object} a fake unique value renderer based off the legend
         *
         */
        function mapServerLegendToRenderer(serverLegend, layerIndex) {
            const layerLegend = serverLegend.layers.find(l => {
                return l.layerId === layerIndex;
            });

            // make the mock renderer
            return {
                type: 'uniqueValue',
                uniqueValueInfos: layerLegend.legend.map(ll => {
                    return {
                        label: ll.label,
                        symbol: {
                            type: 'esriPMS',
                            imageData: ll.imageData,
                            contentType: ll.contentType
                        }
                    };
                })
            };
        }

        /*
         * TODO: move to geoapi as it's stateless and very specific.
         * Orchestrator function that will:
         * - Fetch a legend from an esri map server
         * - Extract legend for a specific sub layer
         * - Convert server legend to a temporary renderer
         * - Convert temporary renderer to a viewer-formatted legend (return value)
         *
         * @function mapServerToLocalLegend
         * @param  {String} mapServerUrl  service url (root service, not indexed endpoint)
         * @param {Integer} layerIndex    the index of the layer in the legend we are interested in
         * @returns {Promise} resolves in a viewer-compatible legend for the given server and layer index
         *
         */
        function mapServerToLocalLegend(mapServerUrl, layerIndex) {
            // get esri legend from server
            return getMapServerLegend(mapServerUrl).then(serverLegendData => {
                // derive renderer for specified layer
                const fakeRenderer = mapServerLegendToRenderer(serverLegendData, layerIndex);
                // convert renderer to viewer specific legend
                return gapiService.gapi.symbology.rendererToLegend(fakeRenderer);
            });
        }

        /**
         * Get feature count from a layer.
         * @function getServiceFeatureCount
         * @param  {String} layerUrl layer url
         * @return {Promise}          promise resolving with a feature count
         */
        function getServiceFeatureCount(layerUrl, finalTry = false) {
            return $http.jsonp(
                `${layerUrl}/query?where=1=1&returnCountOnly=true&returnGeometry=false&f=json&callback=JSON_CALLBACK`)
                .then(result => {
                    if (result.data.count) {
                        return result.data.count;
                    } else if (!finalTry) {
                        return getServiceFeatureCount(layerUrl, true);
                    } else {
                        return $translate.instant('toc.error.resource.countfailed');
                    }
                });
        }

        /**
         * Applies feature count to the toc entries.
         * @function applyFeatureCount
         * @param  {String} geometryType one of geometry types
         * @param  {Object} state legend entry object
         * @param  {Number} count  number of features in the layer
         */
        function applyFeatureCount(geometryType, state, count) {
            if (typeof geometryType === 'undefined') {
                geometryType = 'generic';
            }

            state.features = {
                count: count,
                type: geometryType,
                typeName: $translate.instant(Geo.Layer.Esri.GEOMETRY_TYPES[geometryType])
                    .split('|')[state.features.count === 1 ? 0 : 1]
            };
        }

        /**
         * Applies retrieved symbology to the layer item's state.
         * @function applySymbology
         * @param  {Object} state     layer item
         * @param  {Object} layerData data from the legend endpoint
         */
        function applySymbology(state, layerData) {
            state.symbology = layerData.legend.map(item => {

                const symbologyItem = {
                    svgcode: null,
                    name: null
                };

                // file-based layers don't have symbology labels, default to ''
                // TODO: move label defaulting to geoApi

                // legend items are promises
                item.then(data => {
                    symbologyItem.svgcode = data.svgcode;
                    symbologyItem.name = data.label || '';
                });

                return symbologyItem;
            });
        }
    }
})();
