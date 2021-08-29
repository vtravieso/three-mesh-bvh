import { Vector3, BufferAttribute, Box3, FrontSide, Matrix4 } from 'three';
import { CENTER } from './Constants.js';
import { BYTES_PER_NODE, IS_LEAFNODE_FLAG, buildPackedTree } from './buildFunctions.js';
import {
	raycast,
	raycastFirst,
	shapecast,
	intersectsGeometry,
	setBuffer,
	clearBuffer,
} from './castFunctions.js';
import { OrientedBox } from '../math/OrientedBox.js';
import { SeparatingAxisTriangle } from '../math/SeparatingAxisTriangle.js';
import { PrimitivePool } from '../utils/PrimitivePool.js';
import { arrayToBox } from '../utils/ArrayBoxUtilities.js';
import { iterateOverTriangles, setTriangle } from '../utils/TriangleUtilities.js';
import { convertRaycastIntersect } from '../utils/GeometryRayIntersectUtilities.js';

const SKIP_GENERATION = Symbol( 'skip tree generation' );

const aabb = new Box3();
const aabb2 = new Box3();
const tempMatrix = new Matrix4();
const obb = new OrientedBox();
const obb2 = new OrientedBox();
const temp = new Vector3();
const temp1 = new Vector3();
const temp2 = new Vector3();
const tempBox = new Box3();
const trianglePool = new PrimitivePool( () => new SeparatingAxisTriangle() );

export class MeshBVH {

	static serialize( bvh, options = {} ) {

		if ( options.isBufferGeometry ) {

			console.warn( 'MeshBVH.serialize: The arguments for the function have changed. See documentation for new signature.' );

			return MeshBVH.serialize(
				arguments[ 0 ],
				{
					copyIndexBuffer: arguments[ 2 ] === undefined ? true : arguments[ 2 ],
				}
			);

		}

		options = {
			copyIndexBuffer: true,
			...options,
		};

		const geometry = bvh.geometry;
		const rootData = bvh._roots;
		const indexAttribute = geometry.getIndex();
		const result = {
			roots: rootData,
			index: options.copyIndexBuffer ? indexAttribute.array.slice() : indexAttribute.array,
		};

		return result;

	}

	static deserialize( data, geometry, options = {} ) {

		if ( typeof options === 'boolean' ) {

			console.warn( 'MeshBVH.deserialize: The arguments for the function have changed. See documentation for new signature.' );

			return MeshBVH.deserialize(
				arguments[ 0 ],
				arguments[ 1 ],
				{
					setIndex: arguments[ 2 ] === undefined ? true : arguments[ 2 ],
				}
			);

		}

		options = {
			setIndex: true,
			...options,
		};

		const { index, roots } = data;
		const bvh = new MeshBVH( geometry, { ...options, [ SKIP_GENERATION ]: true } );
		bvh._roots = roots;

		if ( options.setIndex ) {

			const indexAttribute = geometry.getIndex();
			if ( indexAttribute === null ) {

				const newIndex = new BufferAttribute( data.index, 1, false );
				geometry.setIndex( newIndex );

			} else if ( indexAttribute.array !== index ) {

				indexAttribute.array.set( index );
				indexAttribute.needsUpdate = true;

			}

		}

		return bvh;

	}

	constructor( geometry, options = {} ) {

		if ( ! geometry.isBufferGeometry ) {

			throw new Error( 'MeshBVH: Only BufferGeometries are supported.' );

		} else if ( geometry.index && geometry.index.isInterleavedBufferAttribute ) {

			throw new Error( 'MeshBVH: InterleavedBufferAttribute is not supported for the index attribute.' );

		}

		// default options
		options = Object.assign( {

			strategy: CENTER,
			maxDepth: 40,
			maxLeafTris: 10,
			verbose: true,
			useSharedArrayBuffer: false,
			setBoundingBox: true,

			// undocumented options

			// Whether to skip generating the tree. Used for deserialization.
			[ SKIP_GENERATION ]: false

		}, options );

		if ( options.useSharedArrayBuffer && typeof SharedArrayBuffer === 'undefined' ) {

			throw new Error( 'MeshBVH: SharedArrayBuffer is not available.' );

		}

		this._roots = null;
		if ( ! options[ SKIP_GENERATION ] ) {

			this._roots = buildPackedTree( geometry, options );

			if ( ! geometry.boundingBox && options.setBoundingBox ) {

				geometry.boundingBox = this.getBoundingBox( new Box3() );

			}

		}

		// retain references to the geometry so we can use them it without having to
		// take a geometry reference in every function.
		this.geometry = geometry;

	}

	refit( nodeIndices = null, terminationIndices = null ) {

		if ( nodeIndices && Array.isArray( nodeIndices ) ) {

			nodeIndices = new Set( nodeIndices );

		}

		if ( terminationIndices && Array.isArray( terminationIndices ) ) {

			terminationIndices = new Set( terminationIndices );

		}

		const geometry = this.geometry;
		const indexArr = geometry.index.array;
		const posAttr = geometry.attributes.position;
		const posArr = posAttr.array;

		// support for an interleaved position buffer
		const bufferOffset = posAttr.offset || 0;
		let stride = 3;
		if ( posAttr.isInterleavedBufferAttribute ) {

			stride = posAttr.data.stride;

		}

		let buffer, uint32Array, uint16Array, float32Array;
		let byteOffset = 0;
		const roots = this._roots;
		for ( let i = 0, l = roots.length; i < l; i ++ ) {

			buffer = roots[ i ];
			uint32Array = new Uint32Array( buffer );
			uint16Array = new Uint16Array( buffer );
			float32Array = new Float32Array( buffer );

			_traverse( 0, byteOffset );
			byteOffset += buffer.byteLength;

		}

		function _traverse( node32Index, byteOffset, force = false ) {

			const node16Index = node32Index * 2;
			const isLeaf = uint16Array[ node16Index + 15 ] === IS_LEAFNODE_FLAG;
			if ( isLeaf ) {

				const offset = uint32Array[ node32Index + 6 ];
				const count = uint16Array[ node16Index + 14 ];

				let minx = Infinity;
				let miny = Infinity;
				let minz = Infinity;
				let maxx = - Infinity;
				let maxy = - Infinity;
				let maxz = - Infinity;
				for ( let i = 3 * offset, l = 3 * ( offset + count ); i < l; i ++ ) {

					const index = indexArr[ i ] * stride + bufferOffset;
					const x = posArr[ index + 0 ];
					const y = posArr[ index + 1 ];
					const z = posArr[ index + 2 ];

					if ( x < minx ) minx = x;
					if ( x > maxx ) maxx = x;

					if ( y < miny ) miny = y;
					if ( y > maxy ) maxy = y;

					if ( z < minz ) minz = z;
					if ( z > maxz ) maxz = z;

				}

				if (
					float32Array[ node32Index + 0 ] !== minx ||
					float32Array[ node32Index + 1 ] !== miny ||
					float32Array[ node32Index + 2 ] !== minz ||

					float32Array[ node32Index + 3 ] !== maxx ||
					float32Array[ node32Index + 4 ] !== maxy ||
					float32Array[ node32Index + 5 ] !== maxz
				) {

					float32Array[ node32Index + 0 ] = minx;
					float32Array[ node32Index + 1 ] = miny;
					float32Array[ node32Index + 2 ] = minz;

					float32Array[ node32Index + 3 ] = maxx;
					float32Array[ node32Index + 4 ] = maxy;
					float32Array[ node32Index + 5 ] = maxz;

					return true;

				} else {

					return false;

				}

			} else {

				const left = node32Index + 8;
				const right = uint32Array[ node32Index + 6 ];

				// the indentifying node indices provided by the shapecast function include offsets of all
				// root buffers to guarantee they're unique between roots so offset left and right indices here.
				const offsetLeft = left + byteOffset;
				const offsetRight = right + byteOffset;

				let leftChange = false;
				let forceLeft = force || terminationIndices && terminationIndices.has( offsetLeft );
				let traverseLeft = forceLeft || ( nodeIndices ? nodeIndices.has( offsetLeft ) : true );
				if ( traverseLeft ) {

					leftChange = _traverse( left, byteOffset, forceLeft );

				}

				let rightChange = false;
				let forceRight = force || terminationIndices && terminationIndices.has( offsetRight );
				let traverseRight = forceRight || ( nodeIndices ? nodeIndices.has( offsetRight ) : true );
				if ( traverseRight ) {

					rightChange = _traverse( right, byteOffset, forceRight );

				}

				const didChange = leftChange || rightChange;

				if ( didChange ) {

					for ( let i = 0; i < 3; i ++ ) {

						const lefti = left + i;
						const righti = right + i;
						const minLeftValue = float32Array[ lefti ];
						const maxLeftValue = float32Array[ lefti + 3 ];
						const minRightValue = float32Array[ righti ];
						const maxRightValue = float32Array[ righti + 3 ];

						float32Array[ node32Index + i ] = minLeftValue < minRightValue ? minLeftValue : minRightValue;
						float32Array[ node32Index + i + 3 ] = maxLeftValue > maxRightValue ? maxLeftValue : maxRightValue;

					}

				}

				return didChange;

			}

		}

	}

	traverse( callback, rootIndex = 0 ) {

		const buffer = this._roots[ rootIndex ];
		const uint32Array = new Uint32Array( buffer );
		const uint16Array = new Uint16Array( buffer );
		_traverse( 0 );

		function _traverse( node32Index, depth = 0 ) {

			const node16Index = node32Index * 2;
			const isLeaf = uint16Array[ node16Index + 15 ] === IS_LEAFNODE_FLAG;
			if ( isLeaf ) {

				const offset = uint32Array[ node32Index + 6 ];
				const count = uint16Array[ node16Index + 14 ];
				callback( depth, isLeaf, new Float32Array( buffer, node32Index * 4, 6 ), offset, count );

			} else {

				const left = node32Index + BYTES_PER_NODE / 4;
				const right = uint32Array[ node32Index + 6 ];
				const splitAxis = uint32Array[ node32Index + 7 ];
				const stopTraversal = callback( depth, isLeaf, new Float32Array( buffer, node32Index * 4, 6 ), splitAxis );

				if ( ! stopTraversal ) {

					_traverse( left, depth + 1 );
					_traverse( right, depth + 1 );

				}

			}

		}

	}

	/* Core Cast Functions */
	raycast( ray, materialOrSide = FrontSide ) {

		const roots = this._roots;
		const geometry = this.geometry;
		const intersects = [];
		const isMaterial = materialOrSide.isMaterial;
		const isArrayMaterial = Array.isArray( materialOrSide );

		const groups = geometry.groups;
		const side = isMaterial ? materialOrSide.side : materialOrSide;
		for ( let i = 0, l = roots.length; i < l; i ++ ) {

			const materialSide = isArrayMaterial ? materialOrSide[ groups[ i ].materialIndex ].side : side;
			const startCount = intersects.length;

			setBuffer( roots[ i ] );
			raycast( 0, geometry, materialSide, ray, intersects );
			clearBuffer();

			if ( isArrayMaterial ) {

				const materialIndex = groups[ i ].materialIndex;
				for ( let j = startCount, jl = intersects.length; j < jl; j ++ ) {

					intersects[ j ].face.materialIndex = materialIndex;

				}

			}

		}

		return intersects;

	}

	raycastFirst( ray, materialOrSide = FrontSide ) {

		const roots = this._roots;
		const geometry = this.geometry;
		const isMaterial = materialOrSide.isMaterial;
		const isArrayMaterial = Array.isArray( materialOrSide );

		let closestResult = null;

		const groups = geometry.groups;
		const side = isMaterial ? materialOrSide.side : materialOrSide;
		for ( let i = 0, l = roots.length; i < l; i ++ ) {

			const materialSide = isArrayMaterial ? materialOrSide[ groups[ i ].materialIndex ].side : side;

			setBuffer( roots[ i ] );
			const result = raycastFirst( 0, geometry, materialSide, ray );
			clearBuffer();

			if ( result != null && ( closestResult == null || result.distance < closestResult.distance ) ) {

				closestResult = result;
				if ( isArrayMaterial ) {

					result.face.materialIndex = groups[ i ].materialIndex;

				}

			}

		}

		return closestResult;

	}

	intersectsGeometry( otherGeometry, geomToMesh ) {

		const geometry = this.geometry;
		let result = false;
		for ( const root of this._roots ) {

			setBuffer( root );
			result = intersectsGeometry( 0, geometry, otherGeometry, geomToMesh );
			clearBuffer();

			if ( result ) {

				break;

			}

		}

		return result;

	}

	shapecast( callbacks, _intersectsTriangleFunc, _orderNodesFunc ) {

		const geometry = this.geometry;
		if ( callbacks instanceof Function ) {

			if ( _intersectsTriangleFunc ) {

				// Support the previous function signature that provided three sequential index buffer
				// indices here.
				const originalTriangleFunc = _intersectsTriangleFunc;
				_intersectsTriangleFunc = ( tri, index, contained, depth ) => {

					const i3 = index * 3;
					return originalTriangleFunc( tri, i3, i3 + 1, i3 + 2, contained, depth );

				};


			}

			callbacks = {

				boundsTraverseOrder: _orderNodesFunc,
				intersectsBounds: callbacks,
				intersectsTriangle: _intersectsTriangleFunc,
				intersectsRange: null,

			};

			console.warn( 'MeshBVH: Shapecast function signature has changed and now takes an object of callbacks as a second argument. See docs for new signature.' );

		}

		const triangle = trianglePool.getPrimitive();
		let {
			boundsTraverseOrder,
			intersectsBounds,
			intersectsRange,
			intersectsTriangle,
		} = callbacks;

		if ( intersectsRange && intersectsTriangle ) {

			const originalIntersectsRange = intersectsRange;
			intersectsRange = ( offset, count, contained, depth, nodeIndex ) => {

				if ( ! originalIntersectsRange( offset, count, contained, depth, nodeIndex ) ) {

					return iterateOverTriangles( offset, count, geometry, intersectsTriangle, contained, depth, triangle );

				}

				return true;

			};

		} else if ( ! intersectsRange ) {

			if ( intersectsTriangle ) {

				intersectsRange = ( offset, count, contained, depth ) => {

					return iterateOverTriangles( offset, count, geometry, intersectsTriangle, contained, depth, triangle );

				};

			} else {

				intersectsRange = ( offset, count, contained ) => {

					return contained;

				};

			}

		}

		let result = false;
		let byteOffset = 0;
		for ( const root of this._roots ) {

			setBuffer( root );
			result = shapecast( 0, geometry, intersectsBounds, intersectsRange, boundsTraverseOrder, byteOffset );
			clearBuffer();

			if ( result ) {

				break;

			}

			byteOffset += root.byteLength;

		}

		trianglePool.releasePrimitive( triangle );

		return result;

	}

	bvhcast( otherBvh, matrixToLocal, callbacks ) {

		// BVHCast function for intersecting two BVHs against each other. Ultimately just uses two recursive shapecast calls rather
		// than an approach that walks down the tree (see bvhcast.js file for more info).

		let {
			intersectsRanges,
			intersectsTriangles,
		} = callbacks;

		const geometry = otherBvh.geometry;
		const indexAttr = geometry.index;
		const positionAttr = geometry.attributes.position;

		tempMatrix.copy( matrixToLocal ).invert();
		const triangle = trianglePool.getPrimitive();
		const triangle2 = trianglePool.getPrimitive();
		if ( intersectsTriangles ) {

			function iterateOverDoubleTriangles( offset1, count1, offset2, count2, depth1, index1, depth2, index2 ) {

				for ( let i2 = offset2, l2 = offset2 + count2; i2 < l2; i2 ++ ) {

					setTriangle( triangle2, i2 * 3, indexAttr, positionAttr );
					triangle2.a.applyMatrix4( matrixToLocal );
					triangle2.b.applyMatrix4( matrixToLocal );
					triangle2.c.applyMatrix4( matrixToLocal );
					triangle2.needsUpdate = true;

					for ( let i1 = offset1, l1 = offset1 + count1; i1 < l1; i1 ++ ) {

						setTriangle( triangle, i1 * 3, indexAttr, positionAttr );
						triangle.needsUpdate = true;

						if ( intersectsTriangles( triangle, triangle2, i1, i2, depth1, index1, depth2, index2 ) ) {

							return true;

						}

					}

				}

				return false;

			}

			if ( intersectsRanges ) {

				const originalIntersectsRanges = intersectsRanges;
				intersectsRanges = function ( offset1, count1, offset2, count2, depth1, index1, depth2, index2 ) {

					if ( ! originalIntersectsRanges( offset1, count1, offset2, count2, depth1, index1, depth2, index2 ) ) {

						return iterateOverDoubleTriangles( offset1, count1, offset2, count2, depth1, index1, depth2, index2 );

					}

					return true;

				};

			} else {

				intersectsRanges = iterateOverDoubleTriangles;

			}

		}

		this.getBoundingBox( aabb2 );
		aabb2.applyMatrix4( matrixToLocal );
		const result = this.shapecast( {

			intersectsBounds: box => aabb2.intersectsBox( box ),

			intersectsRange: ( offset1, count1, contained, depth1, nodeIndex1, box ) => {

				aabb.copy( box );
				aabb.applyMatrix4( tempMatrix );
				return otherBvh.shapecast( {

					intersectsBounds: box => aabb.intersectsBox( box ),

					intersectsRange: ( offset2, count2, contained, depth2, nodeIndex2 ) => {

						return intersectsRanges( offset1, count1, offset2, count2, depth1, nodeIndex1, depth2, nodeIndex2 );

					},

				} );

			}

		} );

		trianglePool.releasePrimitive( triangle );
		trianglePool.releasePrimitive( triangle2 );
		return result;

	}

	/* Derived Cast Functions */
	intersectsBox( box, boxToMesh ) {

		obb.set( box.min, box.max, boxToMesh );
		obb.needsUpdate = true;

		return this.shapecast(
			{
				intersectsBounds: box => obb.intersectsBox( box ),
				intersectsTriangle: tri => obb.intersectsTriangle( tri )
			}
		);

	}

	intersectsSphere( sphere ) {

		return this.shapecast(
			{
				intersectsBounds: box => sphere.intersectsBox( box ),
				intersectsTriangle: tri => tri.intersectsSphere( sphere )
			}
		);

	}

	closestPointToGeometry( otherGeometry, geometryToBvh, target1 = null, target2 = null, minThreshold = 0, maxThreshold = Infinity ) {

		if ( ! otherGeometry.boundingBox ) {

			otherGeometry.computeBoundingBox();

		}

		obb.set( otherGeometry.boundingBox.min, otherGeometry.boundingBox.max, geometryToBvh );
		obb.needsUpdate = true;

		const geometry = this.geometry;
		const pos = geometry.attributes.position;
		const index = geometry.index;
		const otherPos = otherGeometry.attributes.position;
		const otherIndex = otherGeometry.index;
		const triangle = trianglePool.getPrimitive();
		const triangle2 = trianglePool.getPrimitive();

		let tempTarget1 = null;
		let tempTarget2 = null;
		if ( target1 ) {

			tempTarget1 = temp1;

		}

		if ( target2 ) {

			tempTarget2 = temp2;

		}

		let closestDistance = Infinity;
		obb2.matrix.copy( geometryToBvh ).invert();
		this.shapecast(
			{

				boundsTraverseOrder: box => {

					return obb.distanceToBox( box, Math.min( closestDistance, maxThreshold ) );

				},

				intersectsBounds: ( box, isLeaf, score ) => {

					if ( score < closestDistance && score < maxThreshold ) {

						// if we know the triangles of this bounds will be intersected next then
						// save the bounds to use during triangle checks.
						if ( isLeaf ) {

							obb2.min.copy( box.min );
							obb2.max.copy( box.max );
							obb2.needsUpdate = true;

						}

						return true;

					}

					return false;

				},

				intersectsRange: ( offset, count ) => {

					if ( otherGeometry.boundsTree ) {

						// if the other geometry has a bvh then use the accelerated path where we use shapecast to find
						// the closest bounds in the other geometry to check.
						return otherGeometry.boundsTree.shapecast( {
							boundsTraverseOrder: box => {

								return obb2.distanceToBox( box, Math.min( closestDistance, maxThreshold ) );

							},

							intersectsBounds: ( box, isLeaf, score ) => {

								return score < closestDistance && score < maxThreshold;

							},

							intersectsRange: ( otherOffset, otherCount ) => {

								for ( let i2 = otherOffset * 3, l2 = ( otherOffset + otherCount ) * 3; i2 < l2; i2 += 3 ) {

									setTriangle( triangle2, i2, otherIndex, otherPos );
									triangle2.a.applyMatrix4( geometryToBvh );
									triangle2.b.applyMatrix4( geometryToBvh );
									triangle2.c.applyMatrix4( geometryToBvh );
									triangle2.needsUpdate = true;

									for ( let i = offset * 3, l = ( offset + count ) * 3; i < l; i += 3 ) {

										setTriangle( triangle, i, index, pos );
										triangle.needsUpdate = true;

										const dist = triangle.distanceToTriangle( triangle2, tempTarget1, tempTarget2 );
										if ( dist < closestDistance ) {

											if ( target1 ) {

												target1.copy( tempTarget1 );

											}

											if ( target2 ) {

												target2.copy( tempTarget2 );

											}

											closestDistance = dist;

										}

										// stop traversal if we find a point that's under the given threshold
										if ( dist < minThreshold ) {

											return true;

										}

									}

								}

							},
						} );

					} else {

						// If no bounds tree then we'll just check every triangle.
						const triCount = otherIndex ? otherIndex.count : otherPos.count;
						for ( let i2 = 0, l2 = triCount; i2 < l2; i2 += 3 ) {

							setTriangle( triangle2, i2, otherIndex, otherPos );
							triangle2.a.applyMatrix4( geometryToBvh );
							triangle2.b.applyMatrix4( geometryToBvh );
							triangle2.c.applyMatrix4( geometryToBvh );
							triangle2.needsUpdate = true;

							for ( let i = offset * 3, l = ( offset + count ) * 3; i < l; i += 3 ) {

								setTriangle( triangle, i, index, pos );
								triangle.needsUpdate = true;

								const dist = triangle.distanceToTriangle( triangle2, tempTarget1, tempTarget2 );
								if ( dist < closestDistance ) {

									if ( target1 ) {

										target1.copy( tempTarget1 );

									}

									if ( target2 ) {

										target2.copy( tempTarget2 );

									}

									closestDistance = dist;

								}

								// stop traversal if we find a point that's under the given threshold
								if ( dist < minThreshold ) {

									return true;

								}

							}

						}

					}

				},

			}

		);

		trianglePool.releasePrimitive( triangle );
		trianglePool.releasePrimitive( triangle2 );

		return closestDistance;

	}

	distanceToGeometry( geom, matrix, minThreshold, maxThreshold ) {

		return this.closestPointToGeometry( geom, matrix, null, null, minThreshold, maxThreshold );

	}

	closestPointToPoint( point, target, minThreshold = 0, maxThreshold = Infinity ) {

		// early out if under minThreshold
		// skip checking if over maxThreshold
		// set minThreshold = maxThreshold to quickly check if a point is within a threshold
		// returns Infinity if no value found
		const minThresholdSq = minThreshold * minThreshold;
		const maxThresholdSq = maxThreshold * maxThreshold;
		let closestDistanceSq = Infinity;
		this.shapecast(

			{

				boundsTraverseOrder: box => {

					temp.copy( point ).clamp( box.min, box.max );
					return temp.distanceToSquared( point );

				},

				intersectsBounds: ( box, isLeaf, score ) => {

					return score < closestDistanceSq && score < maxThresholdSq;

				},

				intersectsTriangle: tri => {

					tri.closestPointToPoint( point, temp );
					const distSq = point.distanceToSquared( temp );
					if ( distSq < closestDistanceSq ) {

						if ( target ) {

							target.copy( temp );

						}

						closestDistanceSq = distSq;

					}

					if ( distSq < minThresholdSq ) {

						return true;

					} else {

						return false;

					}

				},

			}

		);

		return Math.sqrt( closestDistanceSq );

	}

	distanceToPoint( point, minThreshold, maxThreshold ) {

		return this.closestPointToPoint( point, null, minThreshold, maxThreshold );

	}

	getBoundingBox( target ) {

		target.makeEmpty();

		const roots = this._roots;
		roots.forEach( buffer => {

			arrayToBox( 0, new Float32Array( buffer ), tempBox );
			target.union( tempBox );

		} );

		return target;

	}

}

// Deprecation
const originalRaycast = MeshBVH.prototype.raycast;
MeshBVH.prototype.raycast = function ( ...args ) {

	if ( args[ 0 ].isMesh ) {

		console.warn( 'MeshBVH: The function signature for "raycast" has changed. See docs for new signature.' );
		const [
			mesh, raycaster, ray, intersects,
		] = args;

		const results = originalRaycast.call( this, ray, mesh.material );
		results.forEach( hit => {

			hit = convertRaycastIntersect( hit, mesh, raycaster );
			if ( hit ) {

				intersects.push( hit );

			}

		} );

		return intersects;

	} else {

		return originalRaycast.apply( this, args );

	}

};

const originalRaycastFirst = MeshBVH.prototype.raycastFirst;
MeshBVH.prototype.raycastFirst = function ( ...args ) {

	if ( args[ 0 ].isMesh ) {

		console.warn( 'MeshBVH: The function signature for "raycastFirst" has changed. See docs for new signature.' );
		const [
			mesh, raycaster, ray,
		] = args;

		return convertRaycastIntersect( originalRaycastFirst.call( this, ray, mesh.material ), mesh, raycaster );

	} else {

		return originalRaycastFirst.apply( this, args );

	}

};

[
	'intersectsGeometry',
	'shapecast',
	'intersectsBox',
	'intersectsSphere',
	'closestPointToGeometry',
	'distanceToGeometry',
	'closestPointToPoint',
	'distanceToPoint',
].forEach( name => {

	const originalFunc = MeshBVH.prototype[ name ];
	MeshBVH.prototype[ name ] = function ( ...args ) {

		if ( args[ 0 ].isMesh ) {

			args.shift();
			console.warn( `MeshBVH: The function signature for "${ name }" has changed and no longer takes Mesh. See docs for new signature.` );

		}

		return originalFunc.apply( this, args );

	};

} );
